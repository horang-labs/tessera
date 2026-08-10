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

test('one-time authenticated bootstrap registers a legacy WSL Project Worktree', async () => {
  const [database, projects, projection, bootstrap] = await Promise.all([
    import('@/lib/db/database'),
    import('@/lib/db/projects'),
    import('@/lib/projects/project-view-projection'),
    import('@/lib/db/worktree-bootstrap'),
  ]);
  await database.initDatabase();

  const repository = createRepository('legacy-wsl-project-root');
  const reportedPath = '/home/work/legacy-wsl-project-root';
  const now = new Date().toISOString();
  database.getDb().prepare(`
    INSERT INTO projects (
      id, decoded_path, display_name, provider, visible, sort_order,
      project_worktree_id, registered_at, updated_at
    ) VALUES (?, ?, ?, NULL, 1, 0, NULL, ?, ?)
  `).run('legacy-wsl-project', reportedPath, 'Legacy WSL Project', now, now);

  assert.equal(projects.getProjectWorktree('legacy-wsl-project'), undefined);

  const translate = async (candidate: string) => (
    candidate === reportedPath ? repository : candidate
  );
  database.getDb().prepare(`
    INSERT INTO _meta (key, value)
    VALUES ('canonical_worktree_bootstrap_v38', 'pending')
    ON CONFLICT(key) DO UPDATE SET value = 'pending'
  `).run();
  const result = await bootstrap.bootstrapCanonicalWorktreeRegistry('wsl', translate);
  assert.equal(result.status, 'completed');
  assert.equal(result.registeredProjects >= 1, true);

  const root = projects.getProjectWorktree('legacy-wsl-project');
  assert.ok(root);
  assert.equal(root.filesystemPath, fs.realpathSync.native(repository));
  assert.equal(root.currentBranch, 'feature/c');

  const projectView = projection.getProjectViewProjection('legacy-wsl-project');
  assert.equal(projectView.projectWorktree.id, root.id);
  assert.equal(projectView.projectWorktree.currentBranch, 'feature/c');
});

test('Session workspace routing opens CLI paths without mutating stored evidence', async () => {
  const [database, projects, sessions, sessionRoots] = await Promise.all([
    import('@/lib/db/database'),
    import('@/lib/db/projects'),
    import('@/lib/db/sessions'),
    import('@/lib/session/session-workspace-root'),
  ]);
  await database.initDatabase();

  const repository = createRepository('reported-path-project');
  const reportedPath = '/home/work/reported-path-project';
  projects.registerProject('reported-project', repository, 'Reported Project');
  const worktreeId = projects.getProjectWorktree('reported-project')!.id;
  sessions.createSession('reported-session', 'reported-project', 'Reported Session', 'codex', {
    workDir: reportedPath,
    worktreeId,
    scopeBranch: 'feature/c',
  });
  sessions.createSession('legacy-reported-session', 'reported-project', 'Legacy Reported', 'codex', {
    workDir: reportedPath,
  });

  const translate = async (candidate: string) => (
    candidate === reportedPath ? repository : candidate
  );

  const sessionRoot = await sessionRoots.resolveSessionWorkspaceFilesystemRoot(
    'reported-session',
    { agentEnvironment: 'wsl', resolveAgentPath: translate },
  );
  assert.equal(sessionRoot, fs.realpathSync.native(repository));
  assert.equal(sessions.getSession('reported-session')?.work_dir, reportedPath);
  assert.equal(sessions.getSession('legacy-reported-session')?.work_dir, reportedPath);
});
