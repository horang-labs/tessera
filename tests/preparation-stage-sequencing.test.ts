/**
 * The two-stage run, exercised through the database the way it actually runs.
 *
 * The stages are separate processes, so what holds them together is the stored
 * status: each exit asks what happens next, and the answer has to keep the
 * agent gate and the log honest across both.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tessera-preparation-stage-test-'));
process.env.TESSERA_DATA_DIR = dataDir;
process.env.TESSERA_PRODUCTION_DB = '1';

type Modules = {
  tasks: typeof import('@/lib/db/tasks');
  taskPreparation: typeof import('@/lib/db/task-preparation');
  statusPolicy: typeof import('@/lib/projects/preparation-status-policy');
};

// Imported inside the tests rather than at the top: the modules read the data
// directory as they load, so the environment above has to be set first, and
// this file is compiled without top-level await.
let loaded: Promise<Modules> | null = null;
function modules(): Promise<Modules> {
  loaded ??= (async () => {
    const [{ initDatabase }, tasks, taskPreparation, statusPolicy] = await Promise.all([
      import('@/lib/db/database'),
      import('@/lib/db/tasks'),
      import('@/lib/db/task-preparation'),
      import('@/lib/projects/preparation-status-policy'),
    ]);
    await initDatabase();
    return { tasks, taskPreparation, statusPolicy };
  })();
  return loaded;
}

let taskCounter = 0;
function freshTask(tasks: Modules['tasks']): string {
  taskCounter += 1;
  const id = `preparation-stage-task-${taskCounter}`;
  tasks.createTask({
    id,
    projectId: dataDir,
    title: `stage sequencing ${taskCounter}`,
  });
  return id;
}

test('the agent is held for the before stage and released the moment it ends', async () => {
  const { tasks, taskPreparation, statusPolicy } = await modules();
  const { finishPreparationStage, getTaskPreparation, startTaskPreparation } = taskPreparation;
  const { blocksAgentStartup } = statusPolicy;
  const taskId = freshTask(tasks);
  startTaskPreparation(taskId, { before: 'cp CLAUDE.md .', after: 'npm install' });

  const held = getTaskPreparation(taskId);
  assert.equal(held?.phase, 'before');
  assert.equal(blocksAgentStartup(held!.status, held!.phase), true);

  finishPreparationStage(taskId, 0, 'copied\n');

  const released = getTaskPreparation(taskId);
  assert.equal(released?.status, 'running', 'the run carries on into the after stage');
  assert.equal(released!.phase, 'after');
  assert.equal(
    blocksAgentStartup(released!.status, released!.phase),
    false,
    'an agent does not wait for work it was never going to wait for',
  );
});

test('the after stage settles the run, and its log lands under the first stage', async () => {
  const { tasks, taskPreparation } = await modules();
  const { finishPreparationStage, getTaskPreparation, startTaskPreparation } = taskPreparation;
  const taskId = freshTask(tasks);
  startTaskPreparation(taskId, { before: 'cp CLAUDE.md .', after: 'npm install' });
  finishPreparationStage(taskId, 0, 'copied');
  finishPreparationStage(taskId, 0, 'installed');

  const settled = getTaskPreparation(taskId);
  assert.equal(settled?.status, 'succeeded');
  assert.equal(settled!.output, 'copied\ninstalled', 'one run reads as one log');
  assert.ok(settled!.finishedAt, 'a settled run has an end');
});

test('with nothing to run afterwards, the before stage settles the run on its own', async () => {
  const { tasks, taskPreparation } = await modules();
  const { finishPreparationStage, getTaskPreparation, startTaskPreparation } = taskPreparation;
  const taskId = freshTask(tasks);
  startTaskPreparation(taskId, { before: 'cp CLAUDE.md .', after: null });

  const result = finishPreparationStage(taskId, 0, 'copied');

  assert.deepEqual(result, { phase: 'before', status: 'succeeded', nextPhase: null });
  assert.equal(getTaskPreparation(taskId)?.status, 'succeeded');
});

test('a before stage that failed ends the run rather than installing on top of it', async () => {
  const { tasks, taskPreparation, statusPolicy } = await modules();
  const { finishPreparationStage, getTaskPreparation, startTaskPreparation } = taskPreparation;
  const { blocksAgentStartup } = statusPolicy;
  const taskId = freshTask(tasks);
  startTaskPreparation(taskId, { before: 'cp missing .', after: 'npm install' });

  const result = finishPreparationStage(taskId, 1, 'no such file');

  assert.deepEqual(result, { phase: 'before', status: 'failed', nextPhase: null });
  const failed = getTaskPreparation(taskId);
  assert.equal(failed?.status, 'failed');
  assert.equal(failed!.exitCode, 1);
  assert.equal(
    blocksAgentStartup(failed!.status, failed!.phase),
    false,
    'a prompt already sent is answered rather than left hanging',
  );
});

test('a project with only an after script never holds the agent', async () => {
  const { tasks, taskPreparation, statusPolicy } = await modules();
  const { finishPreparationStage, getTaskPreparation, startTaskPreparation } = taskPreparation;
  const { blocksAgentStartup } = statusPolicy;
  const taskId = freshTask(tasks);
  startTaskPreparation(taskId, { before: null, after: 'npm install' });

  const running = getTaskPreparation(taskId);
  assert.equal(running?.phase, 'after');
  assert.equal(blocksAgentStartup(running!.status, running!.phase), false);

  const result = finishPreparationStage(taskId, 0, 'installed');
  assert.equal(result?.nextPhase, null);
  assert.equal(getTaskPreparation(taskId)?.status, 'succeeded');
});

test('both stages are stored with the run, so the log has both halves to be read against', async () => {
  const { tasks, taskPreparation } = await modules();
  const { finishPreparationStage, getTaskPreparation, startTaskPreparation } = taskPreparation;
  const taskId = freshTask(tasks);
  startTaskPreparation(taskId, { before: 'cp /real/path/CLAUDE.md .', after: 'npm install' });

  const stored = getTaskPreparation(taskId);
  assert.equal(stored?.script, 'cp /real/path/CLAUDE.md .');
  assert.equal(stored!.afterScript, 'npm install');
});

test('a completion for a run that already settled is refused', async () => {
  const { tasks, taskPreparation } = await modules();
  const { finishPreparationStage, getTaskPreparation, startTaskPreparation } = taskPreparation;
  const taskId = freshTask(tasks);
  startTaskPreparation(taskId, { before: 'true', after: null });
  finishPreparationStage(taskId, 0, 'done');

  // A stray exit from a run that is no longer the current one must not reopen
  // it, nor overwrite the outcome that is on screen.
  assert.equal(finishPreparationStage(taskId, 1, 'late failure'), null);
  const settled = getTaskPreparation(taskId);
  assert.equal(settled?.status, 'succeeded');
  assert.equal(settled!.output, 'done');
});

test('a re-run clears the earlier run rather than appending to it', async () => {
  const { tasks, taskPreparation } = await modules();
  const { finishPreparationStage, getTaskPreparation, startTaskPreparation } = taskPreparation;
  const taskId = freshTask(tasks);
  startTaskPreparation(taskId, { before: 'true', after: null });
  finishPreparationStage(taskId, 1, 'first attempt failed');

  startTaskPreparation(taskId, { before: 'true', after: null });
  const restarted = getTaskPreparation(taskId);
  assert.equal(restarted?.status, 'running');
  assert.equal(restarted!.phase, 'before', 'a re-run starts at the beginning');
  assert.equal(restarted!.output, null, 'the previous log is not what this run printed');
  assert.equal(restarted!.exitCode, null);
});
