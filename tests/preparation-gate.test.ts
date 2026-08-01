/**
 * The gate that holds an agent back, against a real database.
 *
 * What matters here is what it does *not* hold: a directory that is not a
 * prepared worktree, a run that has settled, and the `after` stage. Holding any
 * of those would trade the bug this fixes for a session that hangs.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tessera-preparation-gate-test-'));
process.env.TESSERA_DATA_DIR = dataDir;
process.env.TESSERA_PRODUCTION_DB = '1';

type Modules = {
  sessions: typeof import('@/lib/db/sessions');
  tasks: typeof import('@/lib/db/tasks');
  taskPreparation: typeof import('@/lib/db/task-preparation');
  gate: typeof import('@/lib/projects/preparation-gate');
};

let loaded: Promise<Modules> | null = null;
function modules(): Promise<Modules> {
  loaded ??= (async () => {
    const [{ initDatabase }, sessions, tasks, taskPreparation, gate] = await Promise.all([
      import('@/lib/db/database'),
      import('@/lib/db/sessions'),
      import('@/lib/db/tasks'),
      import('@/lib/db/task-preparation'),
      import('@/lib/projects/preparation-gate'),
    ]);
    await initDatabase();
    return { sessions, tasks, taskPreparation, gate };
  })();
  return loaded;
}

let counter = 0;

/** A task with a session working in its own worktree, which is what the gate looks up by. */
async function worktreeTask(): Promise<{ taskId: string; workDir: string }> {
  const { sessions, tasks } = await modules();
  counter += 1;
  const taskId = `gate-task-${counter}`;
  const workDir = path.join(dataDir, `worktree-${counter}`);

  tasks.createTask({ id: taskId, projectId: dataDir, title: `gate ${counter}` });
  sessions.createSession(
    `gate-session-${counter}`,
    dataDir,
    `gate session ${counter}`,
    'claude-code',
    { workDir, taskId },
  );
  return { taskId, workDir };
}

test('a directory that is not a prepared worktree is never held', async () => {
  const { gate } = await modules();

  assert.deepEqual(
    await gate.waitForPreparationBeforeAgent({ workDir: path.join(dataDir, 'nowhere') }),
    { waited: false },
  );
  // A chat with no working directory at all is the same answer.
  assert.deepEqual(await gate.waitForPreparationBeforeAgent({ workDir: null }), { waited: false });
});

test('an agent is held while the before stage runs, and released when it ends', async () => {
  const { gate, taskPreparation } = await modules();
  const { taskId, workDir } = await worktreeTask();
  taskPreparation.startTaskPreparation(taskId, { before: 'cp CLAUDE.md .', after: null });

  let waitAnnounced = false;
  const held = gate.waitForPreparationBeforeAgent({
    workDir,
    onWaitStarted: () => { waitAnnounced = true; },
  });

  // The wait is announced synchronously, before anything is awaited: the user
  // has to be told the moment their message starts waiting, not afterwards.
  assert.equal(waitAnnounced, true, 'the surface is told as the wait begins');

  const settle = setTimeout(() => {
    taskPreparation.finishPreparationStage(taskId, 0, 'copied');
  }, 400);

  assert.deepEqual(await held, { waited: true, result: 'ready' });
  clearTimeout(settle);
});

test('a run that has already settled holds nothing', async () => {
  const { gate, taskPreparation } = await modules();
  const { taskId, workDir } = await worktreeTask();

  taskPreparation.startTaskPreparation(taskId, { before: 'true', after: null });
  taskPreparation.finishPreparationStage(taskId, 0, 'done');
  assert.deepEqual(await gate.waitForPreparationBeforeAgent({ workDir }), { waited: false });

  // Nor does a failed one — the prompt is answered by an agent that says what
  // went wrong, rather than by nothing at all.
  taskPreparation.startTaskPreparation(taskId, { before: 'false', after: null });
  taskPreparation.finishPreparationStage(taskId, 1, 'boom');
  assert.deepEqual(await gate.waitForPreparationBeforeAgent({ workDir }), { waited: false });
});

test('the after stage holds nothing, because the agent was already released', async () => {
  const { gate, taskPreparation } = await modules();
  const { taskId, workDir } = await worktreeTask();

  taskPreparation.startTaskPreparation(taskId, { before: 'cp CLAUDE.md .', after: 'npm install' });
  taskPreparation.finishPreparationStage(taskId, 0, 'copied');
  assert.equal(taskPreparation.getTaskPreparation(taskId)?.phase, 'after');

  assert.deepEqual(await gate.waitForPreparationBeforeAgent({ workDir }), { waited: false });
});

test('a before stage that never ends releases the agent rather than taking the session with it', async () => {
  const { gate, taskPreparation } = await modules();
  const { taskId, workDir } = await worktreeTask();
  taskPreparation.startTaskPreparation(taskId, { before: 'sleep forever', after: null });

  assert.deepEqual(
    await gate.waitForPreparationBeforeAgent({ workDir, timeoutMs: 500 }),
    { waited: true, result: 'timedOut' },
  );
});
