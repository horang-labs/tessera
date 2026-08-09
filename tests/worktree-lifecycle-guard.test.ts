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

  const rootPath = path.join(testRoot, 'guard-root');
  const linkedPath = path.join(testRoot, 'guard-linked');
  fs.mkdirSync(rootPath, { recursive: true });
  git(rootPath, ['init', '-b', 'main']);
  git(rootPath, ['config', 'user.email', 'test@example.com']);
  git(rootPath, ['config', 'user.name', 'Tessera Test']);
  fs.writeFileSync(path.join(rootPath, 'README.md'), 'guard\n');
  git(rootPath, ['add', 'README.md']);
  git(rootPath, ['commit', '-m', 'initial']);
  git(rootPath, ['worktree', 'add', '-b', 'feature/guard', linkedPath]);

  projects.registerProject('guard-origin', rootPath, 'Guard Origin');
  const worktreeId = tasks.createTask({
    id: 'guard-task',
    projectId: 'guard-origin',
    title: 'Guarded Worktree',
    worktreeBranch: 'feature/guard',
    worktreePath: linkedPath,
  });
  sessions.createSession('guard-session', 'guard-origin', 'Guard session', 'claude-code', {
    taskId: 'guard-task',
    workDir: linkedPath,
    worktreeBranch: 'feature/guard',
    worktreeManaged: true,
  });
  sessions.createSession('guard-direct-session', 'guard-origin', 'Direct guard session', 'codex', {
    workDir: linkedPath,
    worktreeBranch: 'feature/guard',
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

test('external Worktree absence is reported without deleting canonical records', async () => {
  const [archive, projects, sessions, tasks, worktrees] = await Promise.all([
    import('@/lib/archive/archive-service'),
    import('@/lib/db/projects'),
    import('@/lib/db/sessions'),
    import('@/lib/db/tasks'),
    import('@/lib/db/worktrees'),
  ]);
  const rootPath = path.join(testRoot, 'missing-root');
  const linkedPath = path.join(testRoot, 'missing-linked');
  fs.mkdirSync(rootPath, { recursive: true });
  git(rootPath, ['init', '-b', 'main']);
  git(rootPath, ['config', 'user.email', 'test@example.com']);
  git(rootPath, ['config', 'user.name', 'Tessera Test']);
  fs.writeFileSync(path.join(rootPath, 'README.md'), 'missing\n');
  git(rootPath, ['add', 'README.md']);
  git(rootPath, ['commit', '-m', 'initial']);
  git(rootPath, ['worktree', 'add', '-b', 'feature/missing', linkedPath]);

  projects.registerProject('missing-origin', rootPath, 'Missing Origin');
  const worktreeId = tasks.createTask({
    id: 'missing-task',
    projectId: 'missing-origin',
    title: 'Missing Worktree',
    worktreeBranch: 'feature/missing',
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
