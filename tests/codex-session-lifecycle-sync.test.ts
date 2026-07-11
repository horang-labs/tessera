import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tessera-codex-lifecycle-'));
process.env.TESSERA_DATA_DIR = dataDir;
process.env.TESSERA_PRODUCTION_DB = '1';

let database: typeof import('../src/lib/db/database');
let dbProjects: typeof import('../src/lib/db/projects');
let dbSessions: typeof import('../src/lib/db/sessions');
let dbTasks: typeof import('../src/lib/db/tasks');
let sessionHistory: typeof import('../src/lib/session-history')['sessionHistory'];
let sessionOrchestrator: typeof import('../src/lib/session/session-orchestrator')['sessionOrchestrator'];
let archiveSession: typeof import('../src/lib/session/session-archive')['archiveSession'];
let setTaskArchived: typeof import('../src/lib/archive/archive-service')['setTaskArchived'];
let setCodexThreadControlRequestExecutorForTests:
  typeof import('../src/lib/cli/providers/codex/thread-control-client')['setCodexThreadControlRequestExecutorForTests'];
let processManager: typeof import('../src/lib/cli/process-manager')['processManager'];

test.before(async () => {
  database = await import('../src/lib/db/database');
  dbProjects = await import('../src/lib/db/projects');
  dbSessions = await import('../src/lib/db/sessions');
  dbTasks = await import('../src/lib/db/tasks');
  ({ sessionHistory } = await import('../src/lib/session-history'));
  ({ sessionOrchestrator } = await import('../src/lib/session/session-orchestrator'));
  ({ archiveSession } = await import('../src/lib/session/session-archive'));
  ({ setTaskArchived } = await import('../src/lib/archive/archive-service'));
  ({ setCodexThreadControlRequestExecutorForTests } = await import('../src/lib/cli/providers/codex/thread-control-client'));
  ({ processManager } = await import('../src/lib/cli/process-manager'));

  await database.initDatabase();
  dbProjects.registerProject('project-lifecycle', dataDir, 'Lifecycle Project', 'codex');
});

test.afterEach(() => {
  setCodexThreadControlRequestExecutorForTests(null);
});

test.after(async () => {
  await processManager.cleanup();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('rename is remote-first and threadless/non-Codex sessions remain local-only', async () => {
  dbSessions.createSession('rename-codex', 'project-lifecycle', 'Before', 'codex', {
    workDir: dataDir,
    providerState: JSON.stringify({ threadId: 'thread-rename' }),
  });
  setCodexThreadControlRequestExecutorForTests(async (_context, method, params) => {
    assert.equal(method, 'thread/name/set');
    assert.deepEqual(params, { threadId: 'thread-rename', name: 'After' });
    assert.equal(dbSessions.getSession('rename-codex')?.title, 'Before');
    throw new Error('rename rejected');
  });
  await assert.rejects(
    sessionOrchestrator.renameSession('user-1', 'rename-codex', 'After'),
    /rename rejected/,
  );
  assert.equal(dbSessions.getSession('rename-codex')?.title, 'Before');

  const calls: string[] = [];
  setCodexThreadControlRequestExecutorForTests(async (_context, method) => {
    calls.push(method);
    return {};
  });
  dbSessions.createSession('rename-threadless', 'project-lifecycle', 'Local', 'codex');
  dbSessions.createSession('rename-other', 'project-lifecycle', 'Other', 'claude-code');
  await sessionOrchestrator.renameSession('user-1', 'rename-threadless', 'Local 2');
  await sessionOrchestrator.renameSession('user-1', 'rename-other', 'Other 2');
  assert.deepEqual(calls, []);
  assert.equal(dbSessions.getSession('rename-threadless')?.title, 'Local 2');
  assert.equal(dbSessions.getSession('rename-other')?.title, 'Other 2');
});

test('archive RPC failure preserves local state and task partial success is compensated', async () => {
  dbSessions.createSession('archive-one', 'project-lifecycle', 'Archive one', 'codex', {
    workDir: dataDir,
    providerState: JSON.stringify({ threadId: 'thread-archive-one' }),
  });
  setCodexThreadControlRequestExecutorForTests(async () => {
    throw new Error('archive rejected');
  });
  await assert.rejects(archiveSession('archive-one', true, 'user-1'), /archive rejected/);
  assert.equal(dbSessions.getSession('archive-one')?.archived, 0);

  dbTasks.createTask({ id: 'task-archive', projectId: 'project-lifecycle', title: 'Archive task' });
  dbSessions.createSession('archive-task-1', 'project-lifecycle', 'Child 1', 'codex', {
    workDir: dataDir,
    taskId: 'task-archive',
    providerState: JSON.stringify({ threadId: 'thread-task-1' }),
  });
  dbSessions.createSession('archive-task-2', 'project-lifecycle', 'Child 2', 'codex', {
    workDir: dataDir,
    taskId: 'task-archive',
    providerState: JSON.stringify({ threadId: 'thread-task-2' }),
  });
  const calls: Array<{ method: string; threadId: unknown }> = [];
  let archiveAttempts = 0;
  setCodexThreadControlRequestExecutorForTests(async (_context, method, params) => {
    calls.push({ method, threadId: params.threadId });
    if (method === 'thread/archive' && ++archiveAttempts === 2) {
      throw new Error('second archive rejected');
    }
    return {};
  });

  await assert.rejects(setTaskArchived('task-archive', true, 'user-1'), /second archive rejected/);
  assert.equal(calls.length, 3);
  assert.equal(calls[0].method, 'thread/archive');
  assert.equal(calls[1].method, 'thread/archive');
  assert.notEqual(calls[0].threadId, calls[1].threadId);
  assert.deepEqual(calls[2], {
    method: 'thread/unarchive',
    threadId: calls[0].threadId,
  });
  assert.equal(dbTasks.getTask('task-archive')?.archived, false);
});

test('delete preserves local data on remote failure and removes it after success', async () => {
  dbSessions.createSession('delete-codex', 'project-lifecycle', 'Delete me', 'codex', {
    workDir: dataDir,
    providerState: JSON.stringify({ threadId: 'thread-delete' }),
  });
  sessionHistory.recordUserMessage('delete-codex', 'must survive failure');
  setCodexThreadControlRequestExecutorForTests(async () => {
    throw new Error('delete rejected');
  });
  await assert.rejects(
    sessionOrchestrator.deleteSession('user-1', 'delete-codex'),
    /delete rejected/,
  );
  assert.equal(dbSessions.getSession('delete-codex')?.deleted, 0);
  assert.equal(await sessionHistory.historyExists('delete-codex'), true);

  setCodexThreadControlRequestExecutorForTests(async (_context, method, params) => {
    assert.equal(method, 'thread/delete');
    assert.deepEqual(params, { threadId: 'thread-delete' });
    assert.equal(dbSessions.getSession('delete-codex')?.deleted, 0);
    return {};
  });
  await sessionOrchestrator.deleteSession('user-1', 'delete-codex');
  assert.equal(dbSessions.getSession('delete-codex'), undefined);
  assert.equal(await sessionHistory.historyExists('delete-codex'), false);
});
