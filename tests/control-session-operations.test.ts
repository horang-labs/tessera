import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ControlOperationError,
  ControlSessionStartError,
  createControlService,
  type ControlProjectRecord,
  type ControlSessionMutator,
  type ControlSessionRuntimeController,
  type ControlSessionRecord,
  type ControlWorktreeRecord,
} from '../src/lib/control/service';

const PROJECT: ControlProjectRecord = {
  id: 'project-one',
  decodedPath: '/projects/one',
  displayName: 'Project one',
  visible: true,
};

const WORKTREE: ControlWorktreeRecord = {
  worktreeId: 'wt_public_one',
  projectId: PROJECT.id,
  title: 'Feature one',
  branch: 'feature/one',
  filesystemPath: '/worktrees/one',
  preparationStatus: 'succeeded',
  preparationPhase: 'before',
  sessions: [],
};

const CONTEXT = { agentEnvironment: 'native' as const };

function createFixture() {
  const records: ControlSessionRecord[] = [];
  const starts: Array<{
    sessionId: string;
    initialPrompt?: string;
    allowPreparationFailure?: boolean;
  }> = [];
  const removed: string[] = [];
  const observations: Array<{ condition?: string; timeoutMs?: number }> = [];
  const controls: Array<{ kind: string; value?: unknown }> = [];
  let failNextStart: ControlOperationError | null = null;

  const mutator: ControlSessionMutator = {
    create: async ({ worktreeId, provider, title }) => {
      const record: ControlSessionRecord = {
        sessionId: `session-${records.length + 1}`,
        worktreeId,
        projectId: PROJECT.id,
        title: title ?? 'New Session',
        provider,
        providerState: JSON.stringify({ kind: 'terminal' }),
        updatedAt: '2026-08-04T00:00:00.000Z',
      };
      records.push(record);
      return record;
    },
    start: async (request) => {
      starts.push(request);
      if (failNextStart) {
        const error = failNextStart;
        failNextStart = null;
        throw error;
      }
      return { terminalId: `session-${request.sessionId}` };
    },
    removeCreated: async (sessionId) => {
      removed.push(sessionId);
      const index = records.findIndex((record) => record.sessionId === sessionId);
      if (index >= 0) records.splice(index, 1);
    },
  };
  const controller: ControlSessionRuntimeController = {
    prompt: async (_sessionId, text) => {
      controls.push({ kind: 'prompt', value: text });
      return snapshot('running');
    },
    sendKeys: async (_sessionId, keys) => {
      controls.push({ kind: 'keys', value: keys });
      return snapshot('input-required');
    },
    stop: async () => {
      controls.push({ kind: 'stop' });
      return snapshot('exited');
    },
  };
  const service = createControlService({
    appVersion: '1.0.0',
    runtimeId: 'runtime-one',
    projects: { list: () => [PROJECT], get: (id) => id === PROJECT.id ? PROJECT : undefined },
    worktrees: {
      list: () => [WORKTREE],
      get: (id) => id === WORKTREE.worktreeId ? WORKTREE : undefined,
    },
    sessions: {
      list: (worktreeId) => records.filter((record) => record.worktreeId === worktreeId),
      get: (sessionId) => records.find((record) => record.sessionId === sessionId),
    },
    sessionMutator: mutator,
    sessionObserver: {
      read: async () => {
        observations.push({});
        return {
          screen: 'current screen',
          cols: 100,
          rows: 30,
          alternateScreen: false,
          outputSequence: 7,
          terminalId: 'terminal-observed',
          runtimeState: 'turn-complete' as const,
          stateAt: 3000,
          lifecyclePreview: 'response boundary',
        };
      },
      wait: async (_sessionId: string, condition: string, timeoutMs: number) => {
        observations.push({ condition, timeoutMs });
        return {
          screen: 'current screen',
          cols: 100,
          rows: 30,
          alternateScreen: false,
          outputSequence: 7,
          terminalId: 'terminal-observed',
          runtimeState: 'turn-complete' as const,
          stateAt: 3000,
          lifecyclePreview: 'response boundary',
        };
      },
    },
    sessionController: controller,
  });

  return {
    records,
    removed,
    observations,
    controls,
    service,
    starts,
    failStartWith(error: ControlOperationError) { failNextStart = error; },
  };
}

function snapshot(runtimeState: 'running' | 'input-required' | 'exited') {
  return {
    screen: 'current screen',
    cols: runtimeState === 'exited' ? null : 100,
    rows: runtimeState === 'exited' ? null : 30,
    alternateScreen: false,
    outputSequence: 7,
    terminalId: 'terminal-observed',
    runtimeState,
    stateAt: 3000,
  };
}

test('Control creates a durable PTY Session and lists it only through its public Worktree', async () => {
  const fixture = createFixture();

  const created = await fixture.service.createSession({
    worktreeId: WORKTREE.worktreeId,
    provider: 'codex',
    title: 'Inspect checkout',
  }, CONTEXT);

  assert.deepEqual(created, {
    sessionId: 'session-1',
    worktreeId: WORKTREE.worktreeId,
    projectId: PROJECT.id,
    title: 'Inspect checkout',
    provider: 'codex',
    updatedAt: '2026-08-04T00:00:00.000Z',
  });
  assert.deepEqual(await fixture.service.listSessions(WORKTREE.worktreeId, CONTEXT), {
    sessions: [created],
  });
  assert.deepEqual(await fixture.service.showSession(created.sessionId, CONTEXT), created);
  assert.equal(JSON.stringify(created).includes('task'), false);

  await assert.rejects(
    fixture.service.listSessions('task-legacy-one', CONTEXT),
    (error: unknown) => error instanceof ControlOperationError
      && error.code === 'WORKTREE_NOT_FOUND',
  );
});

test('Control reads and waits on a durable Session through the observation seam', async () => {
  const fixture = createFixture();
  const created = await fixture.service.createSession({
    worktreeId: WORKTREE.worktreeId,
    provider: 'codex',
  }, CONTEXT);

  const read = await fixture.service.readSession(created.sessionId, CONTEXT);
  assert.equal(read.runtimeState, 'turn-complete');
  assert.equal(read.screen, 'current screen');

  const waited = await fixture.service.waitForSession({
    sessionId: created.sessionId,
    condition: 'turn-complete',
  }, CONTEXT);
  assert.equal(waited.outputSequence, 7);
  assert.deepEqual(fixture.observations, [
    {},
    { condition: 'turn-complete', timeoutMs: 600_000 },
  ]);
});

test('Control rejects unsupported Session wait conditions and timeouts over one hour', async () => {
  const fixture = createFixture();
  const created = await fixture.service.createSession({
    worktreeId: WORKTREE.worktreeId,
    provider: 'codex',
  }, CONTEXT);

  await assert.rejects(
    fixture.service.waitForSession({
      sessionId: created.sessionId,
      condition: 'running',
      timeoutSeconds: 3_601,
    }, CONTEXT),
    (error: unknown) => error instanceof ControlOperationError
      && error.code === 'INVALID_USAGE',
  );
  await assert.rejects(
    fixture.service.waitForSession({
      sessionId: created.sessionId,
      condition: 'done' as 'running',
    }, CONTEXT),
    (error: unknown) => error instanceof ControlOperationError
      && error.code === 'INVALID_USAGE',
  );
  assert.deepEqual(fixture.observations, []);
});

test('Control validates and projects prompt, named keys, and stop through one runtime seam', async () => {
  const fixture = createFixture();
  const created = await fixture.service.createSession({
    worktreeId: WORKTREE.worktreeId,
    provider: 'codex',
  }, CONTEXT);

  assert.equal((await fixture.service.promptSession({
    sessionId: created.sessionId,
    text: 'first\nsecond',
  }, CONTEXT)).runtimeState, 'running');
  assert.equal((await fixture.service.sendSessionKeys({
    sessionId: created.sessionId,
    keys: ['escape', 'ctrl-c', 'enter'],
  }, CONTEXT)).runtimeState, 'input-required');
  assert.equal((await fixture.service.stopSession(created.sessionId, CONTEXT)).runtimeState, 'exited');
  assert.deepEqual(await fixture.service.showSession(created.sessionId, CONTEXT), created);
  assert.equal(fixture.records[0]?.providerState, JSON.stringify({ kind: 'terminal' }));
  assert.equal((await fixture.service.startSession({
    sessionId: created.sessionId,
  }, CONTEXT)).session.sessionId, created.sessionId);
  assert.deepEqual(fixture.controls, [
    { kind: 'prompt', value: 'first\nsecond' },
    { kind: 'keys', value: ['escape', 'ctrl-c', 'enter'] },
    { kind: 'stop' },
  ]);
  assert.deepEqual(fixture.starts, [{
    sessionId: created.sessionId,
  }]);

  for (const request of [
    () => fixture.service.promptSession({ sessionId: created.sessionId, text: ' \n ' }, CONTEXT),
    () => fixture.service.sendSessionKeys({
      sessionId: created.sessionId,
      keys: ['enter', 'raw-bytes'] as ['enter'],
    }, CONTEXT),
    () => fixture.service.sendSessionKeys({ sessionId: created.sessionId, keys: [] }, CONTEXT),
  ]) {
    await assert.rejects(
      request(),
      (error: unknown) => error instanceof ControlOperationError
        && ['INPUT_NOT_ACCEPTED', 'INVALID_USAGE'].includes(error.code),
    );
  }
  assert.equal(fixture.controls.length, 3);
});

test('Control starts a pre-existing Session without deleting it when detached launch fails', async () => {
  const fixture = createFixture();
  const created = await fixture.service.createSession({
    worktreeId: WORKTREE.worktreeId,
    provider: 'claude-code',
  }, CONTEXT);
  fixture.failStartWith(new ControlOperationError(
    'SESSION_RUNTIME_ALREADY_RUNNING',
    'The Session already has a live PTY runtime.',
    409,
  ));

  await assert.rejects(
    fixture.service.startSession({
      sessionId: created.sessionId,
      initialPrompt: 'Begin work',
    }, CONTEXT),
    (error: unknown) => error instanceof ControlOperationError
      && error.code === 'SESSION_RUNTIME_ALREADY_RUNNING',
  );

  assert.equal(fixture.records.length, 1);
  assert.deepEqual(fixture.removed, []);
  assert.deepEqual(fixture.starts, [{ sessionId: created.sessionId, initialPrompt: 'Begin work' }]);
});

test('Control launch rolls back only its newly created record on a pre-spawn failure', async () => {
  const fixture = createFixture();
  fixture.failStartWith(new ControlOperationError(
    'PREPARATION_FAILED',
    'Worktree preparation failed before an agent could start.',
    409,
  ));

  await assert.rejects(
    fixture.service.launchSession({
      worktreeId: WORKTREE.worktreeId,
      provider: 'opencode',
      initialPrompt: 'Inspect the failure',
      allowPreparationFailure: false,
    }, CONTEXT),
    (error: unknown) => error instanceof ControlOperationError
      && error.code === 'PREPARATION_FAILED',
  );

  assert.deepEqual(fixture.removed, ['session-1']);
  assert.deepEqual(fixture.records, []);

  const launched = await fixture.service.launchSession({
    worktreeId: WORKTREE.worktreeId,
    provider: 'opencode',
    initialPrompt: undefined,
    allowPreparationFailure: true,
  }, CONTEXT);
  assert.equal(launched.terminalId, 'session-session-1');
  assert.equal(launched.session.sessionId, 'session-1');
  assert.deepEqual(fixture.starts.at(-1), {
    sessionId: 'session-1',
    initialPrompt: undefined,
    allowPreparationFailure: true,
  });
});

test('Control launch preserves its durable record when startup fails after PTY spawn', async () => {
  const fixture = createFixture();
  fixture.failStartWith(new ControlSessionStartError(
    'INSTANCE_UNAVAILABLE',
    'Provider initialization failed after spawn.',
    500,
    {},
    'spawned',
  ));

  await assert.rejects(
    fixture.service.launchSession({
      worktreeId: WORKTREE.worktreeId,
      provider: 'codex',
      initialPrompt: 'Begin work',
    }, CONTEXT),
    (error: unknown) => error instanceof ControlSessionStartError
      && error.runtimeSpawned,
  );

  assert.deepEqual(fixture.removed, []);
  assert.equal(fixture.records.length, 1);
  assert.equal(fixture.records[0]?.worktreeId, WORKTREE.worktreeId);
});

test('Control launch preserves its durable record while the Session runtime is opening', async () => {
  const fixture = createFixture();
  fixture.failStartWith(new ControlSessionStartError(
    'INSTANCE_UNAVAILABLE',
    'The Session runtime could not be started.',
    500,
    {},
    'opening',
  ));

  await assert.rejects(
    fixture.service.launchSession({
      worktreeId: WORKTREE.worktreeId,
      provider: 'opencode',
      initialPrompt: 'Keep the opening runtime',
    }, CONTEXT),
    (error: unknown) => error instanceof ControlSessionStartError
      && error.runtimeOwned,
  );

  assert.deepEqual(fixture.removed, []);
  assert.equal(fixture.records.length, 1);
});
