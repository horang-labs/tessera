import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tessera-worktree-lifecycle-'));
process.env.TESSERA_DATA_DIR = path.join(testRoot, 'data');
process.env.TESSERA_PRODUCTION_DB = '1';

const git = (cwd: string, args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

function createLinkedCheckout(name: string): { rootPath: string; linkedPath: string; branch: string } {
  const rootPath = path.join(testRoot, `${name}-root`);
  const linkedPath = path.join(testRoot, `${name}-linked`);
  const branch = `feature/${name}`;
  fs.mkdirSync(rootPath, { recursive: true });
  git(rootPath, ['init', '-b', 'main']);
  git(rootPath, ['config', 'user.email', 'test@example.com']);
  git(rootPath, ['config', 'user.name', 'Tessera Test']);
  fs.writeFileSync(path.join(rootPath, 'README.md'), `${name}\n`);
  git(rootPath, ['add', 'README.md']);
  git(rootPath, ['commit', '-m', 'initial']);
  git(rootPath, ['worktree', 'add', '-b', branch, linkedPath]);
  return { rootPath, linkedPath, branch };
}

test.after(async () => {
  const { processManager } = await import('@/lib/cli/process-manager');
  await processManager.cleanup();
  fs.rmSync(testRoot, { recursive: true, force: true });
});

test('canonical Worktree deletion is guarded by every visible Project view', async () => {
  const [archive, database, projects, sessions, tasks, worktrees] = await Promise.all([
    import('@/lib/archive/archive-service'),
    import('@/lib/db/database'),
    import('@/lib/db/projects'),
    import('@/lib/db/sessions'),
    import('@/lib/db/tasks'),
    import('@/lib/db/worktrees'),
  ]);
  await database.initDatabase();

  const { rootPath, linkedPath, branch } = createLinkedCheckout('guard');

  projects.registerProject('guard-origin', rootPath, 'Guard Origin');
  const worktreeId = tasks.createTask({
    id: 'guard-task',
    projectId: 'guard-origin',
    title: 'Guarded Worktree',
    worktreeBranch: branch,
    worktreePath: linkedPath,
  });
  sessions.createSession('guard-session', 'guard-origin', 'Guard session', 'claude-code', {
    taskId: 'guard-task',
    workDir: linkedPath,
    worktreeBranch: branch,
    worktreeManaged: true,
  });
  sessions.createSession('guard-direct-session', 'guard-origin', 'Direct guard session', 'codex', {
    workDir: linkedPath,
    worktreeBranch: branch,
    worktreeManaged: true,
    worktreeId,
  });
  tasks.setTaskArchived('guard-task', true);
  projects.registerProject('guard-view', linkedPath, 'Guard View');

  await assert.rejects(
    archive.removeArchivedWorktreeById(worktreeId),
    /Guard View.*removed or hidden/i,
  );
  assert.equal(fs.existsSync(linkedPath), true);
  assert.equal(tasks.getTask('guard-task')?.worktreeDeletedAt, undefined);

  projects.removeProject('guard-view');
  assert.ok(sessions.getSession('guard-session'));
  assert.ok(tasks.getTask('guard-task'));
  await archive.removeArchivedWorktreeById(worktreeId);

  assert.equal(fs.existsSync(linkedPath), false);
  assert.ok(tasks.getTask('guard-task')?.worktreeDeletedAt);
  assert.ok(sessions.getSession('guard-session'));
  assert.ok(sessions.getSession('guard-direct-session')?.worktree_deleted_at);
  assert.ok(worktrees.getWorktree(worktreeId), 'canonical Worktree record is retained');
});

test('active Worktree deletion archives and preserves its canonical records', async () => {
  const [archive, projects, sessions, tasks, worktrees] = await Promise.all([
    import('@/lib/archive/archive-service'),
    import('@/lib/db/projects'),
    import('@/lib/db/sessions'),
    import('@/lib/db/tasks'),
    import('@/lib/db/worktrees'),
  ]);
  const { rootPath, linkedPath, branch } = createLinkedCheckout('active-delete');
  projects.registerProject('active-delete-origin', rootPath, 'Active Delete Origin');
  const worktreeId = tasks.createTask({
    id: 'active-delete-task',
    projectId: 'active-delete-origin',
    title: 'Active Delete Worktree',
    worktreeBranch: branch,
    worktreePath: linkedPath,
  });
  sessions.createSession('active-delete-session', 'active-delete-origin', 'Kept session', 'codex', {
    taskId: 'active-delete-task',
    workDir: linkedPath,
  });

  await archive.removeWorktreeById(worktreeId);

  assert.equal(fs.existsSync(linkedPath), false);
  assert.equal(tasks.getTask('active-delete-task')?.archived, true);
  assert.ok(tasks.getTask('active-delete-task')?.worktreeDeletedAt);
  assert.equal(sessions.getSession('active-delete-session')?.deleted, 0);
  assert.ok(worktrees.getWorktree(worktreeId));
});

test('external Worktree absence is reported without deleting canonical records', async () => {
  const [archive, projects, sessions, tasks, worktrees] = await Promise.all([
    import('@/lib/archive/archive-service'),
    import('@/lib/db/projects'),
    import('@/lib/db/sessions'),
    import('@/lib/db/tasks'),
    import('@/lib/db/worktrees'),
  ]);
  const { rootPath, linkedPath, branch } = createLinkedCheckout('missing');

  projects.registerProject('missing-origin', rootPath, 'Missing Origin');
  const worktreeId = tasks.createTask({
    id: 'missing-task',
    projectId: 'missing-origin',
    title: 'Missing Worktree',
    worktreeBranch: branch,
    worktreePath: linkedPath,
  });
  sessions.createSession('missing-session', 'missing-origin', 'Missing session', 'claude-code', {
    taskId: 'missing-task',
    workDir: linkedPath,
  });
  tasks.setTaskArchived('missing-task', true);
  git(rootPath, ['worktree', 'remove', '--force', linkedPath]);

  const item = (await archive.listArchiveItems()).items.find((entry) => entry.id === 'missing-task');
  assert.equal(item?.worktreeStatus, 'missing');
  await assert.rejects(archive.removeArchivedWorktreeById(worktreeId), /unavailable/i);
  assert.equal(tasks.getTask('missing-task')?.worktreeDeletedAt, undefined);
  assert.ok(sessions.getSession('missing-session'));
  assert.ok(worktrees.getWorktree(worktreeId));
});
