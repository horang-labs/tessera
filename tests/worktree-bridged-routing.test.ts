import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { canonicalizeWorktreePath } from '@/lib/db/worktree-identity';
import { resolveManagedWorktreeRoot } from '@/lib/worktrees/managed';

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tessera-bridged-worktree-'));
process.env.TESSERA_DATA_DIR = path.join(testRoot, 'data');
process.env.TESSERA_PRODUCTION_DB = '1';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

function createRepository(name = 'project-c'): string {
  const repository = path.join(testRoot, name);
  fs.mkdirSync(repository, { recursive: true });
  git(repository, ['init', '-b', 'feature/c']);
  git(repository, ['config', 'user.email', 'test@example.com']);
  git(repository, ['config', 'user.name', 'Tessera Test']);
  fs.writeFileSync(path.join(repository, 'BRIDGED.md'), 'Windows server, WSL checkout\n');
  git(repository, ['add', 'BRIDGED.md']);
  git(repository, ['commit', '-m', 'fixture']);
  fs.writeFileSync(path.join(repository, 'uncommitted.txt'), 'routed Git status\n');
  return repository;
}

test.after(() => {
  fs.rmSync(testRoot, { recursive: true, force: true });
});

test('WSL and Windows spellings share one canonical Worktree path key', () => {
  const windowsPath = '\\\\wsl.localhost\\Ubuntu-24.04\\home\\work\\project-c';
  const windowsIdentity = canonicalizeWorktreePath(windowsPath);
  const reportedIdentity = canonicalizeWorktreePath('/home/work/project-c', windowsPath);

  assert.ok(windowsIdentity);
  assert.ok(reportedIdentity);
  assert.equal(reportedIdentity.filesystemPath, windowsIdentity.filesystemPath);
  assert.equal(reportedIdentity.canonicalPathKey, windowsIdentity.canonicalPathKey);
});

test('importing a translated linked checkout reuses its canonical identity and routes Git and Files', async () => {
  const [database, projects, worktrees, gitPanel, workspaceFiles] = await Promise.all([
    import('@/lib/db/database'),
    import('@/lib/db/projects'),
    import('@/lib/db/worktrees'),
    import('@/lib/git/git-panel'),
    import('@/lib/workspace-files/read-workspace-root'),
  ]);
  await database.initDatabase();

  const repository = createRepository();
  const reportedPath = '/home/work/.tessera/worktrees/project-c';
  const knownWorktreeId = worktrees.createPendingWorktree('wt_bridged_linked_c');
  const reportedIdentity = canonicalizeWorktreePath(reportedPath);
  assert.ok(reportedIdentity);
  database.getDb().prepare(`
    UPDATE worktrees
    SET filesystem_path = ?, canonical_path_key = ?
    WHERE id = ?
  `).run(reportedPath, reportedIdentity.canonicalPathKey, knownWorktreeId);

  projects.registerProject('project-c-view', repository, 'Project C', null, {
    equivalentFilesystemPaths: [reportedPath],
  });

  const imported = projects.getProjectWorktree('project-c-view');
  assert.ok(imported);
  assert.equal(imported.id, knownWorktreeId);
  assert.equal(imported.filesystemPath, fs.realpathSync.native(repository));

  const gitData = await gitPanel.getWorktreeGitPanelData(imported.id);
  assert.equal(gitData.branch, 'feature/c');
  assert.equal(gitData.changedFiles.some((file) => file.path === 'uncommitted.txt'), true);

  const files = await workspaceFiles.readWorkspaceRootFiles(imported.filesystemPath!);
  assert.equal(files.files.includes('BRIDGED.md'), true);
  assert.equal(files.files.includes('uncommitted.txt'), true);
});

test('WSL Worktree roots fall back to the configured agent home, not the server home', async () => {
  const root = await resolveManagedWorktreeRoot('/mnt/c/source/project', 'wsl', {
    agentHomeFilesystemPath: '/home/agent-user',
  });

  assert.equal(root, '/home/agent-user/.tessera/worktrees');
});

test('native Worktree root behavior remains unchanged', async () => {
  const existingNativeRoot = await resolveManagedWorktreeRoot('/tmp/native-project', 'native');
  const root = await resolveManagedWorktreeRoot('/tmp/native-project', 'native', {
    agentHomeFilesystemPath: '/should/not/be/used',
  });

  assert.equal(root, existingNativeRoot);
});

test('configured routing translates stored CLI paths before navigation and Files access', async () => {
  const [database, projects, sessions, worktrees, sessionRoots] = await Promise.all([
    import('@/lib/db/database'),
    import('@/lib/db/projects'),
    import('@/lib/db/sessions'),
    import('@/lib/db/worktrees'),
    import('@/lib/session/session-workspace-root'),
  ]);
  await database.initDatabase();

  const repository = createRepository('reported-path-project');
  const reportedPath = '/home/work/reported-path-project';
  const worktreeId = worktrees.createPendingWorktree('wt_reported_path');
  const reportedIdentity = canonicalizeWorktreePath(reportedPath);
  assert.ok(reportedIdentity);
  database.getDb().prepare(`
    UPDATE worktrees SET filesystem_path = ?, canonical_path_key = ? WHERE id = ?
  `).run(reportedPath, reportedIdentity.canonicalPathKey, worktreeId);
  projects.registerProject('reported-project', repository, 'Reported Project');
  database.getDb().prepare(`
    UPDATE projects SET project_worktree_id = ? WHERE id = ?
  `).run(worktreeId, 'reported-project');
  sessions.createSession('reported-session', 'reported-project', 'Reported Session', 'codex', {
    workDir: reportedPath,
    worktreeId,
    scopeBranch: 'feature/c',
  });

  const translate = async (candidate: string) => (
    candidate === reportedPath ? repository : candidate
  );
  await worktrees.routeCanonicalWorktreePaths('wsl', translate);

  const routed = projects.getProjectWorktree('reported-project');
  assert.equal(routed?.id, worktreeId);
  assert.equal(routed?.filesystemPath, fs.realpathSync.native(repository));
  assert.equal(routed?.currentBranch, 'feature/c');

  const sessionRoot = await sessionRoots.resolveSessionWorkspaceFilesystemRoot(
    'reported-session',
    { agentEnvironment: 'wsl', resolveAgentPath: translate },
  );
  assert.equal(sessionRoot, fs.realpathSync.native(repository));
});

test('canonical reconciliation preserves immutable Worktree Creation Scope', async () => {
  const [database, projects, tasks, worktrees] = await Promise.all([
    import('@/lib/db/database'),
    import('@/lib/db/projects'),
    import('@/lib/db/tasks'),
    import('@/lib/db/worktrees'),
  ]);
  await database.initDatabase();

  const repository = createRepository('duplicate-scope-project');
  projects.registerProject('duplicate-scope-project', repository, 'Duplicate Scope');
  const canonicalId = tasks.createTask({
    id: 'canonical-owner-task',
    projectId: 'duplicate-scope-project',
    title: 'Canonical owner',
    worktreePath: repository,
  });
  const duplicateId = worktrees.createPendingWorktree('wt_duplicate_scope');
  const reportedPath = '/home/work/duplicate-scope-project';
  const reportedIdentity = canonicalizeWorktreePath(reportedPath);
  assert.ok(reportedIdentity);
  database.getDb().prepare(`
    UPDATE worktrees SET filesystem_path = ?, canonical_path_key = ? WHERE id = ?
  `).run(reportedPath, reportedIdentity.canonicalPathKey, duplicateId);

  tasks.createTask({
    id: 'scoped-child-task',
    projectId: 'duplicate-scope-project',
    title: 'Scoped child',
    creationScope: { originWorktreeId: duplicateId, branch: 'feature/c' },
  });

  const translate = async (candidate: string) => (
    candidate === reportedPath ? repository : candidate
  );
  await worktrees.routeCanonicalWorktreePaths('wsl', translate);

  const scope = database.getDb().prepare(`
    SELECT creation_scope_worktree_id, creation_scope_branch
    FROM tasks WHERE id = 'scoped-child-task'
  `).get() as { creation_scope_worktree_id: string; creation_scope_branch: string };
  assert.deepEqual(scope, {
    creation_scope_worktree_id: canonicalId,
    creation_scope_branch: 'feature/c',
  });
  assert.equal(worktrees.getWorktree(duplicateId), undefined);
});
