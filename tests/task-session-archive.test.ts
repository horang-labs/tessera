import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tessera-task-session-archive-'));
process.env.TESSERA_DATA_DIR = dataDir;
process.env.TESSERA_PRODUCTION_DB = '1';

const worktreeDir = path.join(dataDir, 'worktree');
fs.mkdirSync(worktreeDir, { recursive: true });

const TASK_ID = 'task-archive-1';

let database: typeof import('../src/lib/db/database');
let dbSessions: typeof import('../src/lib/db/sessions');
let dbTasks: typeof import('../src/lib/db/tasks');
let archiveSession: typeof import('../src/lib/session/session-archive')['archiveSession'];
let archiveService: typeof import('../src/lib/archive/archive-service');
let processManager: typeof import('../src/lib/cli/process-manager')['processManager'];
let projectId: string;

test.before(async () => {
  database = await import('../src/lib/db/database');
  dbSessions = await import('../src/lib/db/sessions');
  dbTasks = await import('../src/lib/db/tasks');
  ({ archiveSession } = await import('../src/lib/session/session-archive'));
  archiveService = await import('../src/lib/archive/archive-service');
  ({ processManager } = await import('../src/lib/cli/process-manager'));
  const { persistCreatedSessionRecord } = await import('../src/lib/session/session-persistence');

  await database.initDatabase();

  // Two sessions sharing one managed worktree, both owned by the same task —
  // the sidebar shape where a worktree row expands into sub-session rows.
  const first = persistCreatedSessionRecord({
    sessionId: 'task-session-a',
    resolvedWorkDir: worktreeDir,
    title: 'Session A',
    providerId: 'claude-code',
    worktreeManaged: true,
  });
  persistCreatedSessionRecord({
    sessionId: 'task-session-b',
    resolvedWorkDir: worktreeDir,
    title: 'Session B',
    providerId: 'claude-code',
    worktreeManaged: true,
  });
  projectId = first.projectId;

  dbTasks.createTask({
    id: TASK_ID,
    projectId,
    title: 'Worktree task',
    worktreeBranch: 'feature/archive-test',
  });
  dbTasks.addSessionToTask(TASK_ID, 'task-session-a');
  dbTasks.addSessionToTask(TASK_ID, 'task-session-b');
});

test.after(async () => {
  await processManager.cleanup();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function taskSessionIds(options?: { includeArchivedSessions?: boolean }): string[] {
  return (dbTasks.getTask(TASK_ID, new Set(), options)?.sessions ?? [])
    .map((session) => session.id)
    .sort();
}

test('archiving one task session drops it from the task without touching its siblings', async () => {
  await archiveSession('task-session-a', true);

  assert.deepEqual(taskSessionIds(), ['task-session-b']);
  assert.deepEqual(
    taskSessionIds({ includeArchivedSessions: true }),
    ['task-session-a', 'task-session-b'],
  );
  assert.equal(dbSessions.getSession('task-session-a')?.archived, 1);
  assert.equal(dbSessions.getSession('task-session-b')?.archived, 0);
  // The worktree is the task's, so it must survive its session being archived.
  assert.equal(dbTasks.getTask(TASK_ID)?.workDir, worktreeDir);
});

test('an archived task session leaves the project session list', () => {
  const ids = dbSessions
    .getSessionsByProject(projectId)
    .sessions.map((session) => session.id);

  assert.equal(ids.includes('task-session-a'), false);
  assert.equal(ids.includes('task-session-b'), true);
});

test('an individually archived task session is listed as its own archive entry', async () => {
  const { items } = await archiveService.listArchiveItems();
  const entry = items.find((item) => item.id === 'task-session-a');

  assert.ok(entry, 'archived task session should appear in the archive list');
  assert.equal(entry.kind, 'chat');
  assert.equal(entry.canRestore, true);
  // Its worktree belongs to the still-live task, so worktree removal must skip it.
  assert.equal(entry.sharedWorktree, true);
  assert.equal(entry.worktreeStatus, 'present');
});

test('worktree retention skips a worktree still owned by a live task', async () => {
  const result = await archiveService.pruneExpiredArchivedWorktrees(0);

  assert.equal(result.removed, 0);
  assert.equal(result.errors.length, 0);
  assert.equal(fs.existsSync(worktreeDir), true);
});

test('restoring the session puts it back into its task', async () => {
  await archiveService.restoreArchivedChat('task-session-a');

  assert.deepEqual(taskSessionIds(), ['task-session-a', 'task-session-b']);
  assert.equal(dbSessions.getSession('task-session-a')?.archived, 0);
});

test('an archived task owns every child, including ones archived on their own', async () => {
  await archiveSession('task-session-a', true);
  await archiveService.setTaskArchived(TASK_ID, true);

  const { items } = await archiveService.listArchiveItems();
  assert.equal(
    items.some((item) => item.kind === 'chat' && item.id === 'task-session-a'),
    false,
    'the task entry owns the session now, so it must not be listed twice',
  );

  const taskEntry = items.find((item) => item.kind === 'task' && item.id === TASK_ID);
  assert.ok(taskEntry);
  assert.deepEqual(
    taskEntry.sessions.map((session) => session.id).sort(),
    ['task-session-a', 'task-session-b'],
  );
});

test('sessions of an archived task cannot be archived or restored on their own', async () => {
  await assert.rejects(
    () => archiveSession('task-session-b', true),
    /archived task/,
  );
  await assert.rejects(
    () => archiveService.restoreArchivedChat('task-session-a'),
    /archived task/,
  );
});

test('restoring the task keeps a session the user archived by hand archived', async () => {
  await archiveService.setTaskArchived(TASK_ID, false);

  assert.deepEqual(taskSessionIds(), ['task-session-b']);
  assert.equal(dbSessions.getSession('task-session-a')?.archived, 1);
});
