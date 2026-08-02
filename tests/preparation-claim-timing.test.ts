/**
 * When a preparation run records that it has started.
 *
 * The worktree route starts preparation without awaiting it and answers at
 * once, so the client can create a session and open its PTY within
 * milliseconds of that answer. The agent gate holds that PTY only if the run
 * has already stored `running`/`before` — a claim made after any await is one
 * the gate can miss, and the agent then starts into a worktree still short the
 * files a CLI reads once, at startup.
 *
 * The ordering is what these tests pin down, so they call the real entry point
 * and read the database before yielding to the event loop. Awaiting first would
 * pass either way and prove nothing.
 *
 * Every run here points at a worktree that does not exist, so it fails as soon
 * as it touches git — after the claim, which is the whole subject.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tessera-preparation-claim-test-'));
process.env.TESSERA_DATA_DIR = dataDir;
process.env.TESSERA_PRODUCTION_DB = '1';

type Modules = {
  projects: typeof import('@/lib/db/projects');
  tasks: typeof import('@/lib/db/tasks');
  taskPreparation: typeof import('@/lib/db/task-preparation');
  statusPolicy: typeof import('@/lib/projects/preparation-status-policy');
  worktreePreparation: typeof import('@/lib/projects/worktree-preparation');
};

// Imported inside the tests rather than at the top: the modules read the data
// directory as they load, so the environment above has to be set first, and
// this file is compiled without top-level await.
let loaded: Promise<Modules> | null = null;
function modules(): Promise<Modules> {
  loaded ??= (async () => {
    const [
      { initDatabase },
      projects,
      tasks,
      taskPreparation,
      statusPolicy,
      worktreePreparation,
    ] = await Promise.all([
      import('@/lib/db/database'),
      import('@/lib/db/projects'),
      import('@/lib/db/tasks'),
      import('@/lib/db/task-preparation'),
      import('@/lib/projects/preparation-status-policy'),
      import('@/lib/projects/worktree-preparation'),
    ]);
    await initDatabase();
    return { projects, tasks, taskPreparation, statusPolicy, worktreePreparation };
  })();
  return loaded;
}

interface Fixture {
  branchName: string;
  projectDir: string;
  taskId: string;
  worktreePath: string;
}

let counter = 0;
function freshFixture(
  { projects, tasks }: Modules,
  scripts: { before?: string | null; after?: string | null },
): Fixture {
  counter += 1;
  const projectDir = path.join(dataDir, `project-${counter}`);
  const taskId = `preparation-claim-task-${counter}`;

  projects.registerProject(projectDir, projectDir, `claim ${counter}`);
  projects.setPreparationScript(projectDir, scripts.before ?? null, 'before');
  projects.setPreparationScript(projectDir, scripts.after ?? null, 'after');
  tasks.createTask({ id: taskId, projectId: projectDir, title: `claim ${counter}` });

  return {
    branchName: `claim-${counter}`,
    projectDir,
    taskId,
    worktreePath: path.join(dataDir, `worktree-${counter}-absent`),
  };
}

function start(mods: Modules, fixture: Fixture) {
  return mods.worktreePreparation.startWorktreePreparation({
    userId: 'preparation-claim-user',
    taskId: fixture.taskId,
    projectDir: fixture.projectDir,
    worktreePath: fixture.worktreePath,
    branchName: fixture.branchName,
  });
}

test('a blocking run is claimed before the first await, where the gate can see it', async () => {
  const mods = await modules();
  const { getTaskPreparation } = mods.taskPreparation;
  const { blocksAgentStartup } = mods.statusPolicy;
  const fixture = freshFixture(mods, { before: 'cp CLAUDE.md .', after: 'npm install' });

  const run = start(mods, fixture);

  // Read without yielding: this is the window the worktree route hands back to
  // the client, and what the gate finds in it decides whether the PTY waits.
  const claimed = getTaskPreparation(fixture.taskId);
  assert.equal(claimed?.status, 'running');
  assert.equal(claimed?.phase, 'before');
  assert.equal(blocksAgentStartup(claimed!.status, claimed!.phase), true);

  await run.catch(() => {});
});

test('the scripts are stored with the claim, before any expansion', async () => {
  const mods = await modules();
  const { getTaskPreparation } = mods.taskPreparation;
  const fixture = freshFixture(mods, { before: 'cp CLAUDE.md .', after: 'npm install' });

  const run = start(mods, fixture);

  const claimed = getTaskPreparation(fixture.taskId);
  assert.equal(claimed?.script, 'cp CLAUDE.md .');
  assert.equal(claimed?.afterScript, 'npm install');

  await run.catch(() => {});
});

test('a run that cannot start releases the claim it made', async () => {
  const mods = await modules();
  const { getTaskPreparation } = mods.taskPreparation;
  const { blocksAgentStartup } = mods.statusPolicy;
  const fixture = freshFixture(mods, { before: 'cp CLAUDE.md .' });

  await start(mods, fixture).catch(() => {});

  // Left running, the claim would hold every agent entering this worktree for
  // the gate's full timeout.
  const settled = getTaskPreparation(fixture.taskId);
  assert.equal(settled?.status, 'failed');
  assert.equal(blocksAgentStartup(settled!.status, settled!.phase), false);
});

test('a run with nothing blocking claims the stage it has, and holds no agent', async () => {
  const mods = await modules();
  const { getTaskPreparation } = mods.taskPreparation;
  const { blocksAgentStartup } = mods.statusPolicy;
  const fixture = freshFixture(mods, { after: 'npm install' });

  const run = start(mods, fixture);

  const claimed = getTaskPreparation(fixture.taskId);
  assert.equal(claimed?.status, 'running');
  assert.equal(claimed?.phase, 'after');
  assert.equal(blocksAgentStartup(claimed!.status, claimed!.phase), false);

  await run.catch(() => {});
});

test('a project with no preparation script claims nothing', async () => {
  const mods = await modules();
  const { getTaskPreparation } = mods.taskPreparation;
  const fixture = freshFixture(mods, {});

  const outcome = await start(mods, fixture);

  assert.deepEqual(outcome, { started: false, reason: 'no_script' });
  assert.equal(getTaskPreparation(fixture.taskId)?.status, 'never_run');
});

test('a second start finds the claim already made and does not run alongside it', async () => {
  const mods = await modules();
  const fixture = freshFixture(mods, { before: 'cp CLAUDE.md .' });

  const first = start(mods, fixture);
  // Same synchronous window as the first claim, which is where two callers
  // racing to prepare one worktree would collide.
  const second = await start(mods, fixture);

  assert.deepEqual(second, { started: false, reason: 'already_running' });
  await first.catch(() => {});
});
