import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tessera-branch-rename-warning-'));
process.env.TESSERA_DATA_DIR = path.join(testRoot, 'data');
process.env.TESSERA_PRODUCTION_DB = '1';

const git = (cwd: string, args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

function createRepository(name: string): string {
  const repository = path.join(testRoot, name);
  fs.mkdirSync(repository, { recursive: true });
  git(repository, ['init', '-b', 'main']);
  git(repository, ['config', 'user.email', 'test@example.com']);
  git(repository, ['config', 'user.name', 'Tessera Test']);
  fs.writeFileSync(path.join(repository, 'README.md'), `${name}\n`);
  git(repository, ['add', 'README.md']);
  git(repository, ['commit', '-m', 'initial']);
  return repository;
}

function snapshotScopeTables(db: { prepare(sql: string): { all(): unknown[] } }): string {
  return JSON.stringify({
    projects: db.prepare('SELECT * FROM projects ORDER BY id').all(),
    worktrees: db.prepare('SELECT * FROM worktrees ORDER BY id').all(),
    sessions: db.prepare('SELECT * FROM sessions ORDER BY id').all(),
    tasks: db.prepare('SELECT * FROM tasks ORDER BY id').all(),
  });
}

test('an exact direct rename warns without revealing or migrating hidden scope', async () => {
  const [database, projects, projection, sessions, tasks] = await Promise.all([
    import('@/lib/db/database'),
    import('@/lib/db/projects'),
    import('@/lib/projects/project-view-projection'),
    import('@/lib/db/sessions'),
    import('@/lib/db/tasks'),
  ]);
  await database.initDatabase();
  const repository = createRepository('direct');
  projects.registerProject('direct-project', repository, 'Direct rename');
  const root = projects.getProjectWorktree('direct-project');
  assert.ok(root);

  sessions.createSession('old-session', 'direct-project', 'Hidden session', 'codex', {
    workDir: repository,
    worktreeId: root.id,
    scopeBranch: 'main',
  });
  tasks.createTask({
    id: 'old-worktree',
    projectId: 'direct-project',
    title: 'Hidden worktree',
    worktreeBranch: 'feature/child',
    creationScope: { originWorktreeId: root.id, branch: 'main' },
    startPoint: 'main',
  });
  git(repository, ['branch', '-m', 'renamed']);

  const before = snapshotScopeTables(database.getDb());
  const result = projection.getProjectViewProjection('direct-project');
  const after = snapshotScopeTables(database.getDb());

  assert.deepEqual(result.sessions, []);
  assert.deepEqual(result.linkedWorktrees, []);
  assert.deepEqual(result.branchRenameWarning, {
    previousBranch: 'main',
    currentBranch: 'renamed',
  });
  assert.equal(JSON.stringify(result).includes('old-session'), false);
  assert.equal(JSON.stringify(result).includes('old-worktree'), false);
  assert.equal(after, before, 'projection and rename inspection must not mutate the database');
  assert.equal(sessions.getSession('old-session')?.scope_branch, 'main');
  assert.deepEqual(tasks.getTask('old-worktree')?.creationScope, {
    originWorktreeId: root.id,
    branch: 'main',
  });

  git(repository, ['branch', '-m', 'renamed-again']);
  const multiHop = projection.getProjectViewProjection('direct-project');
  assert.equal(multiHop.branchRenameWarning, undefined);
  assert.deepEqual(multiHop.sessions, []);
  assert.deepEqual(multiHop.linkedWorktrees, []);
});

test('a branch mismatch without rename evidence uses ordinary exact-name filtering', async () => {
  const { projects, projection, sessions } = await (async () => {
    const [projects, projection, sessions] = await Promise.all([
      import('@/lib/db/projects'),
      import('@/lib/projects/project-view-projection'),
      import('@/lib/db/sessions'),
    ]);
    return { projects, projection, sessions };
  })();
  const repository = createRepository('mismatch');
  projects.registerProject('mismatch-project', repository, 'Mismatch');
  const root = projects.getProjectWorktree('mismatch-project');
  assert.ok(root);
  sessions.createSession('mismatch-session', 'mismatch-project', 'Hidden', 'codex', {
    workDir: repository,
    worktreeId: root.id,
    scopeBranch: 'main',
  });
  git(repository, ['checkout', '-b', 'different']);

  const result = projection.getProjectViewProjection('mismatch-project');
  assert.deepEqual(result.sessions, []);
  assert.equal(result.branchRenameWarning, undefined);
});

test('unavailable reflog history does not speculate about a real rename', async () => {
  const [projects, projection, sessions] = await Promise.all([
    import('@/lib/db/projects'),
    import('@/lib/projects/project-view-projection'),
    import('@/lib/db/sessions'),
  ]);
  const repository = createRepository('expired');
  projects.registerProject('expired-project', repository, 'Expired reflog');
  const root = projects.getProjectWorktree('expired-project');
  assert.ok(root);
  sessions.createSession('expired-session', 'expired-project', 'Hidden', 'codex', {
    workDir: repository,
    worktreeId: root.id,
    scopeBranch: 'main',
  });
  git(repository, ['branch', '-m', 'renamed-without-history']);
  const reflog = path.join(repository, '.git', 'logs', 'refs', 'heads', 'renamed-without-history');
  assert.equal(fs.existsSync(reflog), true);
  fs.rmSync(reflog);

  const result = projection.getProjectViewProjection('expired-project');
  assert.deepEqual(result.sessions, []);
  assert.equal(result.branchRenameWarning, undefined);
  assert.equal(sessions.getSession('expired-session')?.scope_branch, 'main');
});
