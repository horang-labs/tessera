import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tessera-codex-fork-'));
process.env.TESSERA_DATA_DIR = dataDir;
process.env.TESSERA_PRODUCTION_DB = '1';

let database: typeof import('../src/lib/db/database');
let dbProjects: typeof import('../src/lib/db/projects');
let dbCollections: typeof import('../src/lib/db/collections');
let dbTasks: typeof import('../src/lib/db/tasks');
let dbSessions: typeof import('../src/lib/db/sessions');
let sessionHistory: typeof import('../src/lib/session-history')['sessionHistory'];
let forkCodexSession: typeof import('../src/lib/session/session-fork')['forkCodexSession'];
let setCodexThreadControlRequestExecutorForTests:
  typeof import('../src/lib/cli/providers/codex/thread-control-client')['setCodexThreadControlRequestExecutorForTests'];
let processManager: typeof import('../src/lib/cli/process-manager')['processManager'];

test.before(async () => {
  database = await import('../src/lib/db/database');
  dbProjects = await import('../src/lib/db/projects');
  dbCollections = await import('../src/lib/db/collections');
  dbTasks = await import('../src/lib/db/tasks');
  dbSessions = await import('../src/lib/db/sessions');
  ({ sessionHistory } = await import('../src/lib/session-history'));
  ({ forkCodexSession } = await import('../src/lib/session/session-fork'));
  ({ setCodexThreadControlRequestExecutorForTests } = await import('../src/lib/cli/providers/codex/thread-control-client'));
  ({ processManager } = await import('../src/lib/cli/process-manager'));

  await database.initDatabase();
  dbProjects.registerProject('project-1', dataDir, 'Fork Project', 'codex');
  dbCollections.createCollection('collection-1', 'project-1', 'Forks', '#ffffff', 0);
  dbTasks.createTask({
    id: 'task-1',
    projectId: 'project-1',
    title: 'Source task',
    collectionId: 'collection-1',
    worktreeBranch: 'feature/source',
  });
});

test.after(async () => {
  setCodexThreadControlRequestExecutorForTests(null);
  await processManager.cleanup();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('native fork persists a new thread and clones independent Tessera history', async () => {
  dbSessions.createSession('source-session', 'project-1', 'Source title', 'codex', {
    workDir: dataDir,
    worktreeManaged: true,
    taskId: 'task-1',
    collectionId: 'collection-1',
    model: 'gpt-5.4',
    reasoningEffort: 'high',
    serviceTier: 'fast',
    providerState: JSON.stringify({ threadId: 'thread-source', goal: { stale: true } }),
  });
  dbSessions.updateSession('source-session', { worktree_branch: 'feature/source' });
  sessionHistory.recordUserMessage('source-session', 'before fork');
  sessionHistory.recordServerMessage('source-session', {
    type: 'message',
    role: 'assistant',
    content: 'source reply',
    messageId: 'assistant-source',
  });

  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  setCodexThreadControlRequestExecutorForTests(async (_context, method, params) => {
    calls.push({ method, params });
    if (method === 'thread/fork') {
      return {
        thread: {
          id: 'thread-child',
          forkedFromId: 'thread-source',
        },
      };
    }
    return {};
  });

  const fork = await forkCodexSession('user-1', 'source-session');
  assert.notEqual(fork.sessionId, 'source-session');
  assert.equal(fork.threadId, 'thread-child');
  assert.deepEqual(calls, [
    { method: 'thread/fork', params: { threadId: 'thread-source' } },
  ]);

  const source = dbSessions.getSession('source-session');
  const child = dbSessions.getSession(fork.sessionId);
  assert.equal(dbSessions.extractThreadId(source?.provider_state ?? null), 'thread-source');
  assert.deepEqual(JSON.parse(child?.provider_state ?? '{}'), { threadId: 'thread-child' });
  assert.equal(child?.project_id, 'project-1');
  assert.equal(child?.work_dir, dataDir);
  assert.equal(child?.task_id, 'task-1');
  assert.equal(child?.collection_id, 'collection-1');
  assert.equal(child?.worktree_branch, 'feature/source');
  assert.equal(child?.worktree_managed, 1);
  assert.equal(child?.model, 'gpt-5.4');
  assert.equal(child?.reasoning_effort, 'high');
  assert.equal(child?.service_tier, 'fast');
  assert.equal(child?.has_custom_title, 1);

  const sourceBefore = await sessionHistory.readEvents('source-session');
  const childBefore = await sessionHistory.readEvents(fork.sessionId);
  assert.deepEqual(childBefore, sourceBefore);

  sessionHistory.recordUserMessage(fork.sessionId, 'child only');
  const sourceAfter = await sessionHistory.readEvents('source-session');
  const childAfter = await sessionHistory.readEvents(fork.sessionId);
  assert.deepEqual(sourceAfter, sourceBefore);
  assert.equal(childAfter.length, childBefore.length + 1);
});

test('fork RPC failure leaves no destination row or history artifact', async () => {
  dbSessions.createSession('failing-source', 'project-1', 'Failure source', 'codex', {
    workDir: dataDir,
    providerState: JSON.stringify({ threadId: 'thread-failing-source' }),
  });
  sessionHistory.recordUserMessage('failing-source', 'keep me');
  const beforeCount = (database.getDb().prepare('SELECT COUNT(*) AS count FROM sessions').get() as { count: number }).count;

  setCodexThreadControlRequestExecutorForTests(async () => {
    throw new Error('fork unavailable');
  });

  await assert.rejects(forkCodexSession('user-1', 'failing-source'), /fork unavailable/);
  const afterCount = (database.getDb().prepare('SELECT COUNT(*) AS count FROM sessions').get() as { count: number }).count;
  assert.equal(afterCount, beforeCount);
  assert.equal(await sessionHistory.historyExists('failing-source'), true);
});
