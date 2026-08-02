import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { NextRequest } from 'next/server';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tessera-skill-preparation-test-'));
process.env.TESSERA_DATA_DIR = dataDir;
process.env.TESSERA_PRODUCTION_DB = '1';
process.env.TESSERA_ELECTRON_AUTH_BYPASS = '1';

type Modules = {
  route: typeof import('@/app/api/sessions/[id]/skills/route');
  sessions: typeof import('@/lib/db/sessions');
  tasks: typeof import('@/lib/db/tasks');
  taskPreparation: typeof import('@/lib/db/task-preparation');
  openCodeDiscovery: typeof import('@/lib/cli/providers/opencode/command-discovery-client');
  processManager: typeof import('@/lib/cli/process-manager')['processManager'];
};

let loaded: Promise<Modules> | null = null;
function modules(): Promise<Modules> {
  loaded ??= (async () => {
    const [
      { initDatabase },
      route,
      sessions,
      tasks,
      taskPreparation,
      openCodeDiscovery,
      { processManager },
    ] = await Promise.all([
      import('@/lib/db/database'),
      import('@/app/api/sessions/[id]/skills/route'),
      import('@/lib/db/sessions'),
      import('@/lib/db/tasks'),
      import('@/lib/db/task-preparation'),
      import('@/lib/cli/providers/opencode/command-discovery-client'),
      import('@/lib/cli/process-manager'),
    ]);
    await initDatabase();
    return { route, sessions, tasks, taskPreparation, openCodeDiscovery, processManager };
  })();
  return loaded;
}

test.after(async () => {
  const { openCodeDiscovery, processManager } = await modules();
  openCodeDiscovery.setOpenCodeCommandDiscoveryExecutorForTests(null);
  await processManager.cleanup();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('pre-session skill discovery waits until blocking preparation finishes', async () => {
  const {
    route,
    sessions,
    tasks,
    taskPreparation,
    openCodeDiscovery,
  } = await modules();
  const taskId = 'skill-preparation-task';
  const sessionId = 'skill-preparation-session';
  const workDir = path.join(dataDir, 'worktree');

  tasks.createTask({ id: taskId, projectId: dataDir, title: 'skill preparation' });
  sessions.createSession(sessionId, dataDir, 'skill preparation', 'opencode', {
    taskId,
    workDir,
  });
  taskPreparation.startTaskPreparation(taskId, {
    before: 'cp -R "$TESSERA_PROJECT_DIR/.opencode" .',
    after: null,
  });

  let discoveryCalls = 0;
  openCodeDiscovery.setOpenCodeCommandDiscoveryExecutorForTests(async () => {
    discoveryCalls += 1;
    return [{ name: 'copied-skill', description: 'Available after preparation' }];
  });

  const responsePromise = route.GET(
    new NextRequest(`http://localhost/api/sessions/${sessionId}/skills`),
    { params: Promise.resolve({ id: sessionId }) },
  );

  try {
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(
      discoveryCalls,
      0,
      'provider discovery must not read a worktree while its blocking copy stage is running',
    );
  } finally {
    taskPreparation.finishPreparationStage(taskId, 0, 'copied');
  }
  const response = await responsePromise;
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    skills: [
      { name: 'copied-skill', description: 'Available after preparation' },
      { name: 'compact', description: 'compact the session' },
    ],
  });
  assert.equal(discoveryCalls, 1);
});

test('failed blocking preparation never becomes an incomplete skill catalog', async () => {
  const {
    route,
    sessions,
    tasks,
    taskPreparation,
    openCodeDiscovery,
  } = await modules();
  const taskId = 'failed-skill-preparation-task';
  const sessionId = 'failed-skill-preparation-session';
  const workDir = path.join(dataDir, 'failed-worktree');

  tasks.createTask({ id: taskId, projectId: dataDir, title: 'failed skill preparation' });
  sessions.createSession(sessionId, dataDir, 'failed skill preparation', 'opencode', {
    taskId,
    workDir,
  });
  taskPreparation.startTaskPreparation(taskId, {
    before: 'cp missing .',
    after: null,
  });
  taskPreparation.finishPreparationStage(taskId, 1, 'missing');

  let discoveryCalls = 0;
  openCodeDiscovery.setOpenCodeCommandDiscoveryExecutorForTests(async () => {
    discoveryCalls += 1;
    return [];
  });

  const response = await route.GET(
    new NextRequest(`http://localhost/api/sessions/${sessionId}/skills`),
    { params: Promise.resolve({ id: sessionId }) },
  );

  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    error: 'Worktree preparation failed before skill discovery.',
    code: 'preparation_failed',
    retryable: true,
  });
  assert.equal(discoveryCalls, 0);
});
