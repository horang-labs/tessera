import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { before } from 'node:test';
import type { ServerTransportMessage } from '@/lib/ws/message-types';
import type { TerminalCreateOptions, TerminalPtyFactory } from '@/lib/terminal/types';
import { mintPaneToken, resolvePaneToken } from '@/lib/terminal/pane-token-registry';

process.env.TESSERA_DATA_DIR = mkdtempSync(path.join(tmpdir(), 'tessera-terminal-test-'));
process.env.NODE_ENV = 'test';

let TerminalManager: typeof import('@/lib/terminal/terminal-manager').TerminalManager;
let workspace = '';

before(async () => {
  const [{ initDatabase }, { registerProject }, terminalModule] = await Promise.all([
    import('@/lib/db/database'),
    import('@/lib/db/projects'),
    import('@/lib/terminal/terminal-manager'),
  ]);
  TerminalManager = terminalModule.TerminalManager;
  await initDatabase();
  workspace = mkdtempSync(path.join(tmpdir(), 'tessera-terminal-workspace-'));
  registerProject('terminal-test-project', workspace, 'Terminal test project');
});

class FakePty {
  readonly writes: string[] = [];
  readonly resizes: Array<{ cols: number; rows: number }> = [];
  killCount = 0;
  private dataListeners: Array<(data: string) => void> = [];
  private exitListeners: Array<(event: { exitCode: number; signal?: number }) => void> = [];

  onData(callback: (data: string) => void): void {
    this.dataListeners.push(callback);
  }

  onExit(callback: (event: { exitCode: number; signal?: number }) => void): void {
    this.exitListeners.push(callback);
  }

  write(data: string): void {
    this.writes.push(data);
  }

  resize(cols: number, rows: number): void {
    this.resizes.push({ cols, rows });
  }

  kill(): void {
    this.killCount += 1;
  }

  emitData(data: string): void {
    for (const listener of this.dataListeners) listener(data);
  }

  emitExit(exitCode: number, signal?: number): void {
    for (const listener of this.exitListeners) listener({ exitCode, signal });
  }
}

function createFactory(spawned: FakePty[]): TerminalPtyFactory {
  return {
    spawn() {
      const pty = new FakePty();
      spawned.push(pty);
      return pty;
    },
  };
}

function createOptions(overrides: Partial<TerminalCreateOptions> = {}): TerminalCreateOptions {
  return {
    terminalId: 'terminal-a',
    userId: 'user-a',
    connectionId: 'connection-a',
    surfaceId: 'surface-a',
    cwd: workspace,
    sessionId: 'session-a',
    shellKind: 'powershell',
    cols: 100,
    rows: 30,
    ...overrides,
  };
}

function nextImmediate(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

test('concurrent session opens spawn once and disconnect only detaches its surface', async () => {
  const delivered: Array<{ connectionId: string; message: ServerTransportMessage }> = [];
  const spawned: FakePty[] = [];
  const factory = createFactory(spawned);
  let firstLaunchObserverDisposeCount = 0;
  let secondLaunchObserverDisposeCount = 0;
  let releaseLoader!: () => void;
  const loaderGate = new Promise<void>((resolve) => { releaseLoader = resolve; });
  const manager = new TerminalManager(
    (connectionId, message) => delivered.push({ connectionId, message }),
    async () => {
      await loaderGate;
      return factory;
    },
  );

  const first = manager.create(createOptions({
    launchObserverDisposer: () => { firstLaunchObserverDisposeCount += 1; },
  }));
  const second = manager.create(createOptions({
    terminalId: 'terminal-proposed-by-second-window',
    connectionId: 'connection-b',
    surfaceId: 'surface-b',
    launchObserverDisposer: () => { secondLaunchObserverDisposeCount += 1; },
  }));
  releaseLoader();
  await Promise.all([first, second]);

  assert.equal(spawned.length, 1);
  assert.equal(firstLaunchObserverDisposeCount, 0);
  assert.equal(secondLaunchObserverDisposeCount, 1);
  const starts = delivered.filter(({ message }) => message.type === 'terminal_started');
  assert.deepEqual(starts.map(({ connectionId }) => connectionId).sort(), ['connection-a', 'connection-b']);
  assert.ok(starts.every(({ message }) => message.type === 'terminal_started' && message.terminalId === 'terminal-a'));
  assert.deepEqual(manager.getRuntimeSummary(), { activeCount: 1, sessionCount: 1 });

  delivered.length = 0;
  manager.detachConnection('connection-a');
  manager.write('terminal-a', 'user-a', 'connection-a', 'surface-a', 'rejected');
  manager.write('terminal-a', 'user-a', 'connection-b', 'surface-b', 'accepted');
  assert.deepEqual(spawned[0].writes, ['accepted']);

  spawned[0].emitData('only-the-attached-surface');
  await nextImmediate();
  const outputs = delivered.filter(({ message }) => message.type === 'terminal_output');
  assert.equal(outputs.length, 1);
  assert.equal(outputs[0].connectionId, 'connection-b');
  assert.equal(spawned[0].killCount, 0);

  await manager.closeSession('session-a', 'user-a');
  assert.equal(spawned[0].killCount, 1);
  assert.equal(firstLaunchObserverDisposeCount, 1);
  assert.equal(secondLaunchObserverDisposeCount, 1);
  assert.deepEqual(manager.getRuntimeSummary(), { activeCount: 0, sessionCount: 0 });
});

test('terminal reservations isolate concurrent sessions before either PTY starts', async () => {
  const delivered: ServerTransportMessage[] = [];
  const spawned: FakePty[] = [];
  const manager = new TerminalManager(
    (_connectionId, message) => delivered.push(message),
    async () => createFactory(spawned),
  );
  const firstTerminalId = manager.reserveTerminalId('user-a', 'shared-proposal', 'session-one');
  const secondTerminalId = manager.reserveTerminalId('user-a', 'shared-proposal', 'session-two');
  assert.notEqual(firstTerminalId, secondTerminalId);
  const abandonedTerminalId = manager.reserveTerminalId(
    'user-a',
    'abandoned-proposal',
    'abandoned-session',
  );
  manager.releaseTerminalReservation(
    'user-a',
    'abandoned-session',
    abandonedTerminalId,
  );
  assert.equal(
    manager.reserveTerminalId('user-a', 'abandoned-proposal', 'replacement-session'),
    'abandoned-proposal',
    'preparation failure cleanup must release both reservation directions',
  );
  manager.releaseTerminalReservation('user-a', 'replacement-session', 'abandoned-proposal');
  const firstToken = mintPaneToken({
    terminalId: firstTerminalId,
    userId: 'user-a',
    sessionId: 'session-one',
    providerId: 'codex',
  });
  const secondToken = mintPaneToken({
    terminalId: secondTerminalId,
    userId: 'user-a',
    sessionId: 'session-two',
    providerId: 'codex',
  });

  await Promise.all([
    manager.create(createOptions({
      terminalId: 'shared-proposal',
      sessionId: 'session-one',
      paneToken: firstToken,
    })),
    manager.create(createOptions({
      terminalId: 'shared-proposal',
      sessionId: 'session-two',
      connectionId: 'connection-b',
      surfaceId: 'surface-b',
      paneToken: secondToken,
    })),
  ]);

  assert.equal(spawned.length, 2);
  const startedTerminalIds = delivered
    .filter((message) => message.type === 'terminal_started')
    .map((message) => message.type === 'terminal_started' ? message.terminalId : '')
    .sort();
  assert.deepEqual(startedTerminalIds, [firstTerminalId, secondTerminalId].sort());
  assert.equal(resolvePaneToken(firstToken)?.terminalId, firstTerminalId);
  assert.equal(resolvePaneToken(secondToken)?.terminalId, secondTerminalId);
  assert.deepEqual(manager.getRuntimeSummary(), { activeCount: 2, sessionCount: 2 });

  await manager.shutdownAll();
});

test('session PTY lifecycle reports running until the process exits', async () => {
  const spawned: FakePty[] = [];
  const runtimeStates: Array<{
    sessionId: string;
    terminalId: string;
    userId: string;
    running: boolean;
  }> = [];
  const manager = new TerminalManager(
    () => {},
    async () => createFactory(spawned),
    undefined,
    {
      onSessionRuntimeStateChange: (state) => runtimeStates.push(state),
    },
  );

  await manager.create(createOptions());
  assert.deepEqual(runtimeStates, [{
    sessionId: 'session-a',
    terminalId: 'terminal-a',
    userId: 'user-a',
    running: true,
  }]);
  assert.deepEqual([...manager.getActiveSessionIds('user-a')], ['session-a']);

  manager.detachConnection('connection-a');
  assert.deepEqual(runtimeStates, [{
    sessionId: 'session-a',
    terminalId: 'terminal-a',
    userId: 'user-a',
    running: true,
  }]);
  assert.deepEqual([...manager.getActiveSessionIds('user-a')], ['session-a']);

  spawned[0].emitExit(0);
  assert.deepEqual(runtimeStates, [
    { sessionId: 'session-a', terminalId: 'terminal-a', userId: 'user-a', running: true },
    { sessionId: 'session-a', terminalId: 'terminal-a', userId: 'user-a', running: false },
  ]);
  assert.deepEqual([...manager.getActiveSessionIds('user-a')], []);
});

test('a provider-declared single Escape settles a running turn when the stop hook is omitted', async () => {
  const spawned: FakePty[] = [];
  const inferredStates: ServerTransportMessage[] = [];
  const manager = new TerminalManager(
    () => {},
    async () => createFactory(spawned),
    undefined,
    {
      interruptSettleMs: 10,
      onSessionStateChange: ({ message }) => inferredStates.push(message),
    },
  );

  await manager.create(createOptions({ interruptInputPolicy: 'single-escape' }));
  manager.recordSessionState({
    type: 'session_state',
    sessionId: 'session-a',
    terminalId: 'terminal-a',
    status: 'running',
    hookEvent: 'UserPromptSubmit',
  }, 'user-a');

  manager.write('terminal-a', 'user-a', 'connection-a', 'surface-a', '\x1b');
  assert.deepEqual(spawned[0].writes, ['\x1b']);
  await new Promise((resolve) => setTimeout(resolve, 25));

  assert.equal(
    manager.getSessionStateForSession('session-a', 'user-a')?.status,
    'idle',
  );
  assert.deepEqual(inferredStates.map((state) => (
    state.type === 'session_state' ? [state.status, state.hookEvent] : [state.type]
  )), [['idle', 'InterruptFallback']]);
});

test('a terminal without the single-Escape policy does not infer an interrupt', async () => {
  const spawned: FakePty[] = [];
  const inferredStates: ServerTransportMessage[] = [];
  const manager = new TerminalManager(
    () => {},
    async () => createFactory(spawned),
    undefined,
    {
      interruptSettleMs: 10,
      onSessionStateChange: ({ message }) => inferredStates.push(message),
    },
  );

  await manager.create(createOptions({ interruptInputPolicy: 'none' }));
  manager.recordSessionState({
    type: 'session_state',
    sessionId: 'session-a',
    terminalId: 'terminal-a',
    status: 'running',
    hookEvent: 'UserPromptSubmit',
  }, 'user-a');

  manager.write('terminal-a', 'user-a', 'connection-a', 'surface-a', '\x1b');
  await new Promise((resolve) => setTimeout(resolve, 25));

  assert.equal(
    manager.getSessionStateForSession('session-a', 'user-a')?.status,
    'running',
  );
  assert.deepEqual(inferredStates, []);
});

test('PTY Escape fallback does not overwrite a stop hook from the same turn', async () => {
  const spawned: FakePty[] = [];
  const inferredStates: ServerTransportMessage[] = [];
  const manager = new TerminalManager(
    () => {},
    async () => createFactory(spawned),
    undefined,
    {
      interruptSettleMs: 10,
      onSessionStateChange: ({ message }) => inferredStates.push(message),
    },
  );

  await manager.create(createOptions({ interruptInputPolicy: 'single-escape' }));
  manager.recordSessionState({
    type: 'session_state',
    sessionId: 'session-a',
    terminalId: 'terminal-a',
    status: 'running',
    hookEvent: 'UserPromptSubmit',
  }, 'user-a');

  manager.write('terminal-a', 'user-a', 'connection-a', 'surface-a', '\x1b');
  manager.recordSessionState({
    type: 'session_state',
    sessionId: 'session-a',
    terminalId: 'terminal-a',
    status: 'completed',
    hookEvent: 'Stop',
  }, 'user-a');
  await new Promise((resolve) => setTimeout(resolve, 25));

  assert.equal(
    manager.getSessionStateForSession('session-a', 'user-a')?.status,
    'completed',
  );
  assert.deepEqual(inferredStates, []);
});

test('PTY Escape fallback keeps running while a background subagent is active', async () => {
  const spawned: FakePty[] = [];
  const manager = new TerminalManager(
    () => {},
    async () => createFactory(spawned),
    undefined,
    { interruptSettleMs: 10 },
  );

  await manager.create(createOptions({ interruptInputPolicy: 'single-escape' }));
  manager.recordSessionState({
    type: 'session_state',
    sessionId: 'session-a',
    terminalId: 'terminal-a',
    status: 'running',
    hookEvent: 'SubagentStart',
    hasWorkingSubagents: true,
  }, 'user-a');

  manager.write('terminal-a', 'user-a', 'connection-a', 'surface-a', '\x1b');
  await new Promise((resolve) => setTimeout(resolve, 25));

  assert.equal(
    manager.getSessionStateForSession('session-a', 'user-a')?.status,
    'running',
  );
});

test('PTY Escape fallback rejects late tool activity but accepts the next prompt', async () => {
  const spawned: FakePty[] = [];
  const manager = new TerminalManager(
    () => {},
    async () => createFactory(spawned),
    undefined,
    { interruptSettleMs: 10 },
  );

  await manager.create(createOptions({ interruptInputPolicy: 'single-escape' }));
  manager.recordSessionState({
    type: 'session_state',
    sessionId: 'session-a',
    terminalId: 'terminal-a',
    status: 'running',
    hookEvent: 'UserPromptSubmit',
  }, 'user-a');
  manager.write('terminal-a', 'user-a', 'connection-a', 'surface-a', '\x1b');
  await new Promise((resolve) => setTimeout(resolve, 25));

  const acceptedLateTool = manager.recordSessionState({
    type: 'session_state',
    sessionId: 'session-a',
    terminalId: 'terminal-a',
    status: 'running',
    hookEvent: 'PostToolUse',
  }, 'user-a');
  assert.equal(acceptedLateTool, false);
  assert.equal(
    manager.getSessionStateForSession('session-a', 'user-a')?.status,
    'idle',
  );

  const acceptedNextPrompt = manager.recordSessionState({
    type: 'session_state',
    sessionId: 'session-a',
    terminalId: 'terminal-a',
    status: 'running',
    hookEvent: 'UserPromptSubmit',
  }, 'user-a');
  assert.equal(acceptedNextPrompt, true);
  assert.equal(
    manager.getSessionStateForSession('session-a', 'user-a')?.status,
    'running',
  );
});

test('native CLI fork rebinds one live PTY from the parent session to the child', async () => {
  const spawned: FakePty[] = [];
  const delivered: ServerTransportMessage[] = [];
  const runtimeStates: Array<{
    sessionId: string;
    terminalId: string;
    userId: string;
    running: boolean;
  }> = [];
  const runtimeRebounds: Array<{
    previousSessionId: string;
    sessionId: string;
    terminalId: string;
    userId: string;
  }> = [];
  const observed: string[] = [];
  const disposed: string[] = [];
  const manager = new TerminalManager(
    (_connectionId, message) => delivered.push(message),
    async () => createFactory(spawned),
    ({ sessionId }) => {
      observed.push(sessionId);
      return () => disposed.push(sessionId);
    },
    {
      onSessionRuntimeStateChange: (state) => runtimeStates.push(state),
      onSessionRuntimeRebound: (state) => runtimeRebounds.push(state),
    },
  );

  await manager.create(createOptions());
  await nextImmediate();

  assert.equal(
    manager.markProviderSessionIdentityBackground(
      'terminal-a',
      'user-a',
      'provider-child',
    ),
    true,
  );
  assert.equal(
    manager.isProviderSessionIdentityBackground('terminal-a', 'user-a', 'provider-child'),
    true,
  );
  assert.equal(manager.getSessionIdForTerminal('terminal-a', 'user-a'), 'session-a');

  assert.equal(
    manager.rebindSession('terminal-a', 'user-a', 'session-a', 'session-child'),
    true,
  );
  await nextImmediate();

  assert.deepEqual([...manager.getActiveSessionIds('user-a')], ['session-child']);
  assert.equal(manager.getSessionIdForTerminal('terminal-a', 'user-a'), 'session-child');
  assert.equal(manager.resolveTerminalId('user-a', 'child-proposal', 'session-child'), 'terminal-a');
  assert.equal(manager.submitSessionInput('session-a', 'user-a', 'old session'), false);
  assert.equal(manager.submitSessionInput('session-child', 'user-a', 'new session'), true);
  assert.deepEqual(spawned[0].writes, ['new session\r']);
  assert.equal(spawned[0].killCount, 0);
  assert.equal(
    manager.activateProviderSessionIdentity(
      'terminal-a',
      'user-a',
      'provider-child',
      'provider-parent',
    ),
    true,
  );
  assert.equal(
    manager.isProviderSessionIdentityBackground('terminal-a', 'user-a', 'provider-child'),
    false,
  );
  assert.equal(
    manager.isProviderSessionIdentityRetired('terminal-a', 'user-a', 'provider-parent'),
    true,
  );
  assert.equal(
    manager.activateProviderSessionIdentity('terminal-a', 'user-a', 'provider-parent'),
    false,
  );
  assert.equal(manager.getSessionIdForTerminal('terminal-a', 'user-a'), 'session-child');
  assert.deepEqual(manager.getSessionReboundsForUser('user-a'), [{
    previousSessionId: 'session-a',
    sessionId: 'session-child',
    terminalId: 'terminal-a',
  }]);
  assert.deepEqual(observed, ['session-a', 'session-child']);
  assert.deepEqual(disposed, ['session-a']);
  assert.deepEqual(runtimeStates, [
    { sessionId: 'session-a', terminalId: 'terminal-a', userId: 'user-a', running: true },
  ]);
  assert.deepEqual(runtimeRebounds, [{
    previousSessionId: 'session-a',
    sessionId: 'session-child',
    terminalId: 'terminal-a',
    userId: 'user-a',
  }]);

  assert.equal(manager.hasOrIsOpening('terminal-a', 'user-a', 'session-a'), false);
  const reservedParentTerminalId = manager.reserveTerminalId(
    'user-a',
    'terminal-a',
    'session-a',
  );
  assert.notEqual(reservedParentTerminalId, 'terminal-a');
  const parentPaneToken = mintPaneToken({
    terminalId: reservedParentTerminalId,
    userId: 'user-a',
    sessionId: 'session-a',
    providerId: 'codex',
  });
  delivered.length = 0;
  await manager.create(createOptions({
    connectionId: 'connection-b',
    surfaceId: 'surface-b',
    paneToken: parentPaneToken,
  }));
  assert.equal(spawned.length, 2, 'opening the parent must not attach to the child PTY');
  const parentStart = delivered.find((message) => message.type === 'terminal_started');
  assert.equal(parentStart?.type, 'terminal_started');
  if (parentStart?.type === 'terminal_started') {
    assert.equal(parentStart.terminalId, reservedParentTerminalId);
    assert.equal(resolvePaneToken(parentPaneToken)?.terminalId, parentStart.terminalId);
  }
  assert.deepEqual(
    manager.getSessionReboundsForUser('user-a'),
    [],
    'a reopened parent must not be rewritten to the child on reconnect',
  );

  await manager.shutdownAll();
});

test('cold attach receives one snapshot boundary followed by monotonic live output', async () => {
  const delivered: Array<{ connectionId: string; message: ServerTransportMessage }> = [];
  const spawned: FakePty[] = [];
  const manager = new TerminalManager(
    (connectionId, message) => delivered.push({ connectionId, message }),
    async () => createFactory(spawned),
  );

  await manager.create(createOptions());
  spawned[0].emitData('snapshot-marker');
  await nextImmediate();
  delivered.length = 0;

  await manager.create(createOptions({
    terminalId: 'different-client-proposal',
    connectionId: 'connection-b',
    surfaceId: 'surface-b',
  }));

  const targeted = delivered.filter(({ connectionId }) => connectionId === 'connection-b');
  assert.deepEqual(targeted.map(({ message }) => message.type), ['terminal_started', 'terminal_snapshot']);
  const snapshot = targeted[1].message;
  assert.equal(snapshot.type, 'terminal_snapshot');
  if (snapshot.type === 'terminal_snapshot') {
    assert.equal(snapshot.seq, 1);
    assert.match(snapshot.data, /snapshot-marker/);
  }

  delivered.length = 0;
  spawned[0].emitData('live-marker');
  await nextImmediate();
  const live = delivered.filter(({ message }) => message.type === 'terminal_output');
  assert.equal(live.length, 2);
  for (const { message } of live) {
    assert.equal(message.type, 'terminal_output');
    if (message.type === 'terminal_output') {
      assert.equal(message.seq, 2);
      assert.equal(message.data, 'live-marker');
    }
  }

  await manager.shutdownAll();
});

test('resize redraw cannot erase scrollback even when ED3 is split across PTY chunks', async () => {
  const delivered: Array<{ connectionId: string; message: ServerTransportMessage }> = [];
  const spawned: FakePty[] = [];
  const manager = new TerminalManager(
    (connectionId, message) => delivered.push({ connectionId, message }),
    async () => createFactory(spawned),
  );

  await manager.create(createOptions({
    cols: 40,
    rows: 8,
    resizeScrollbackPolicy: 'preserve-on-ed3',
  }));
  const history = Array.from(
    { length: 80 },
    (_, index) => `ROW_${String(index + 1).padStart(4, '0')}\r\n`,
  ).join('');
  spawned[0].emitData(history);
  await nextImmediate();
  delivered.length = 0;

  manager.resize('terminal-a', 'user-a', 'connection-a', 'surface-a', 24, 8, true);
  spawned[0].emitData('\x1b[');
  manager.resize('terminal-a', 'user-a', 'connection-a', 'surface-a', 26, 8, true);
  spawned[0].emitData('3J\x1b[2J\x1b[HRESIZED_REDRAW');
  await nextImmediate();

  const resizeOutput = delivered
    .filter(({ message }) => message.type === 'terminal_output')
    .map(({ message }) => message.type === 'terminal_output' ? message.data : '')
    .join('');
  assert.doesNotMatch(resizeOutput, /\x1b\[3J/);
  assert.match(resizeOutput, /RESIZED_REDRAW/);

  delivered.length = 0;
  await manager.create(createOptions({
    terminalId: 'different-client-proposal',
    connectionId: 'connection-b',
    surfaceId: 'surface-b',
    cols: 26,
    rows: 8,
  }));

  const snapshot = delivered.find(({ connectionId, message }) =>
    connectionId === 'connection-b' && message.type === 'terminal_snapshot'
  )?.message;
  assert.equal(snapshot?.type, 'terminal_snapshot');
  if (snapshot?.type === 'terminal_snapshot') {
    assert.match(snapshot.data, /ROW_0001/);
    assert.match(snapshot.data, /RESIZED_REDRAW/);
  }

  delivered.length = 0;
  manager.resize('terminal-a', 'user-a', 'connection-b', 'surface-b', 28, 8, true);
  spawned[0].emitData('\x1b[');
  manager.write('terminal-a', 'user-a', 'connection-b', 'surface-b', 'user-input');
  spawned[0].emitData('3J');
  await nextImmediate();
  const resizeClear = delivered
    .filter(({ message }) => message.type === 'terminal_output')
    .map(({ message }) => message.type === 'terminal_output' ? message.data : '')
    .join('');
  assert.doesNotMatch(resizeClear, /\x1b\[3J/);

  delivered.length = 0;
  spawned[0].emitData('\x1b[3J');
  await nextImmediate();
  const explicitClear = delivered
    .filter(({ message }) => message.type === 'terminal_output')
    .map(({ message }) => message.type === 'terminal_output' ? message.data : '')
    .join('');
  assert.match(explicitClear, /\x1b\[3J/);

  await manager.shutdownAll();
});

test('a late exit from an older generation cannot erase its replacement runtime', async () => {
  const delivered: Array<{ connectionId: string; message: ServerTransportMessage }> = [];
  const spawned: FakePty[] = [];
  const runtimeStates: Array<{
    sessionId: string;
    terminalId: string;
    userId: string;
    running: boolean;
  }> = [];
  const manager = new TerminalManager(
    (connectionId, message) => delivered.push({ connectionId, message }),
    async () => createFactory(spawned),
    undefined,
    {
      onSessionRuntimeStateChange: (state) => runtimeStates.push(state),
    },
  );

  await manager.create(createOptions());
  const firstStart = delivered.find(({ message }) => message.type === 'terminal_started')?.message;
  assert.equal(firstStart?.type, 'terminal_started');
  await manager.close('terminal-a', 'user-a');

  delivered.length = 0;
  await manager.create(createOptions());
  const secondStart = delivered.find(({ message }) => message.type === 'terminal_started')?.message;
  assert.equal(secondStart?.type, 'terminal_started');
  if (firstStart?.type === 'terminal_started' && secondStart?.type === 'terminal_started') {
    assert.equal(secondStart.generation, firstStart.generation + 1);
  }
  const runtimeStatesBeforeLateExit = [...runtimeStates];

  spawned[0].emitExit(0);
  assert.deepEqual(runtimeStates, runtimeStatesBeforeLateExit);
  assert.deepEqual(manager.getRuntimeSummary(), { activeCount: 1, sessionCount: 1 });
  spawned[1].emitData('replacement-is-alive');
  await nextImmediate();
  assert.ok(delivered.some(({ message }) =>
    message.type === 'terminal_output' && message.data === 'replacement-is-alive',
  ));

  await manager.shutdownAll();
});

test('session close racing an in-flight spawn leaves no orphan PTY', async () => {
  const spawned: FakePty[] = [];
  const factory = createFactory(spawned);
  let releaseLoader!: () => void;
  const loaderGate = new Promise<void>((resolve) => { releaseLoader = resolve; });
  const manager = new TerminalManager(
    () => {},
    async () => {
      await loaderGate;
      return factory;
    },
  );

  const create = manager.create(createOptions());
  const close = manager.closeSession('session-a', 'user-a');
  releaseLoader();
  await Promise.all([create, close]);

  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].killCount, 1);
  assert.deepEqual(manager.getRuntimeSummary(), { activeCount: 0, sessionCount: 0 });
});

test('session observer is installed once and a late disposer runs after terminal close', async () => {
  const spawned: FakePty[] = [];
  const observed: Array<{ sessionId: string; terminalId: string; generation: number }> = [];
  let releaseObserver!: () => void;
  const observerGate = new Promise<void>((resolve) => { releaseObserver = resolve; });
  let disposeCount = 0;
  const manager = new TerminalManager(
    () => {},
    async () => createFactory(spawned),
    async ({ sessionId, terminalId, generation }) => {
      observed.push({ sessionId, terminalId, generation });
      await observerGate;
      return () => { disposeCount += 1; };
    },
  );

  await manager.create(createOptions());
  await manager.create(createOptions({ connectionId: 'connection-b', surfaceId: 'surface-b' }));
  assert.deepEqual(observed, [{ sessionId: 'session-a', terminalId: 'terminal-a', generation: 1 }]);

  await manager.closeSession('session-a', 'user-a');
  assert.equal(disposeCount, 0);
  releaseObserver();
  await nextImmediate();

  assert.equal(disposeCount, 1);
  assert.equal(spawned[0].killCount, 1);
});

test('host shutdown counts and drains an in-flight spawn before returning', async () => {
  const spawned: FakePty[] = [];
  const factory = createFactory(spawned);
  let releaseLoader!: () => void;
  const loaderGate = new Promise<void>((resolve) => { releaseLoader = resolve; });
  const manager = new TerminalManager(
    () => {},
    async () => {
      await loaderGate;
      return factory;
    },
  );

  const create = manager.create(createOptions());
  assert.deepEqual(manager.getRuntimeSummary(), { activeCount: 1, sessionCount: 1 });
  const shutdown = manager.shutdownAll();
  releaseLoader();
  await Promise.all([create, shutdown]);

  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].killCount, 1);
  assert.deepEqual(manager.getRuntimeSummary(), { activeCount: 0, sessionCount: 0 });
});

test('PTY exit during cold snapshot still delivers fallback snapshot before exit', async () => {
  const delivered: Array<{ connectionId: string; message: ServerTransportMessage }> = [];
  const spawned: FakePty[] = [];
  const factory: TerminalPtyFactory = {
    spawn() {
      const pty = new FakePty();
      spawned.push(pty);
      queueMicrotask(() => {
        pty.emitData('last-output-before-exit');
        setTimeout(() => pty.emitExit(7), 0);
      });
      return pty;
    },
  };
  const manager = new TerminalManager(
    (connectionId, message) => delivered.push({ connectionId, message }),
    async () => factory,
  );

  await manager.create(createOptions());
  const targeted = delivered
    .filter(({ connectionId }) => connectionId === 'connection-a')
    .map(({ message }) => message);
  const snapshotIndex = targeted.findIndex((message) => message.type === 'terminal_snapshot');
  const exitIndex = targeted.findIndex((message) => message.type === 'terminal_exit');
  assert.ok(snapshotIndex >= 0);
  assert.ok(exitIndex > snapshotIndex, JSON.stringify(targeted));
  const snapshot = targeted[snapshotIndex];
  assert.equal(snapshot.type, 'terminal_snapshot');
  if (snapshot.type === 'terminal_snapshot') {
    assert.match(snapshot.data, /last-output-before-exit/);
  }
  const exit = targeted[exitIndex];
  assert.equal(exit.type, 'terminal_exit');
  if (exit.type === 'terminal_exit') assert.equal(exit.exitCode, 7);
  assert.deepEqual(manager.getRuntimeSummary(), { activeCount: 0, sessionCount: 0 });
});

test('spawn and resize clamp hostile terminal dimensions', async () => {
  const spawned: FakePty[] = [];
  let spawnDimensions: { cols: number; rows: number } | null = null;
  const factory: TerminalPtyFactory = {
    spawn(_command, _args, options) {
      spawnDimensions = { cols: options.cols, rows: options.rows };
      const pty = new FakePty();
      spawned.push(pty);
      return pty;
    },
  };
  const manager = new TerminalManager(() => {}, async () => factory);
  await manager.create(createOptions({ cols: Number.MAX_SAFE_INTEGER, rows: Number.POSITIVE_INFINITY }));
  assert.deepEqual(spawnDimensions, { cols: 1_000, rows: 24 });

  manager.resize('terminal-a', 'user-a', 'connection-a', 'surface-a', 99_999, 99_999, true);
  assert.deepEqual(spawned[0].resizes.at(-1), { cols: 1_000, rows: 500 });
  await manager.shutdownAll();
});

test('claiming an already-sized viewport does not send a redundant PTY resize', async () => {
  const spawned: FakePty[] = [];
  const manager = new TerminalManager(() => {}, async () => createFactory(spawned));

  await manager.create(createOptions({ cols: 100, rows: 30 }));
  manager.resize('terminal-a', 'user-a', 'connection-a', 'surface-a', 100, 30, true);
  assert.deepEqual(spawned[0].resizes, []);

  manager.resize('terminal-a', 'user-a', 'connection-a', 'surface-a', 120, 40, true);
  assert.deepEqual(spawned[0].resizes, [{ cols: 120, rows: 40 }]);
  await manager.shutdownAll();
});

test('PTY spawn normalizes inherited color opt-outs at the manager boundary', async () => {
  let spawnEnv: NodeJS.ProcessEnv | null = null;
  const factory: TerminalPtyFactory = {
    spawn(_command, _args, options) {
      spawnEnv = options.env;
      return new FakePty();
    },
  };
  const manager = new TerminalManager(() => {}, async () => factory);

  await manager.create(createOptions({
    launchEnv: {
      NO_COLOR: '1',
      FORCE_COLOR: '0',
      CLICOLOR: '0',
    },
  }));

  assert.ok(spawnEnv);
  assert.equal(spawnEnv.NO_COLOR, undefined);
  assert.equal(spawnEnv.FORCE_COLOR, undefined);
  assert.equal(spawnEnv.CLICOLOR, undefined);
  assert.equal(spawnEnv.TERM, 'xterm-256color');
  assert.equal(spawnEnv.COLORTERM, 'truecolor');
  assert.equal(spawnEnv.TERM_PROGRAM, 'Tessera');

  await manager.shutdownAll();
});

test('agent PTY startup answers color probes before forwarding renderer output', async () => {
  const delivered: ServerTransportMessage[] = [];
  const spawned: FakePty[] = [];
  const manager = new TerminalManager(
    (_connectionId, message) => delivered.push(message),
    async () => createFactory(spawned),
  );

  await manager.create(createOptions({
    launchSpec: { program: 'claude' },
    appearance: {
      mode: 'light',
      foreground: '#25282b',
      background: '#fafaf9',
    },
  }));
  delivered.length = 0;

  spawned[0].emitData('\x1b]10;?\x1b\\\x1b]11;?\x1b\\ready');
  await nextImmediate();

  assert.deepEqual(spawned[0].writes, [
    '\x1b]10;rgb:2525/2828/2b2b\x1b\\',
    '\x1b]11;rgb:fafa/fafa/f9f9\x1b\\',
  ]);
  assert.deepEqual(
    delivered.filter((message) => message.type === 'terminal_output')
      .map((message) => message.type === 'terminal_output' ? message.data : ''),
    ['ready'],
  );

  await manager.shutdownAll();
});

test('subscribed agent PTY receives live terminal color-scheme updates', async () => {
  const delivered: ServerTransportMessage[] = [];
  const spawned: FakePty[] = [];
  const manager = new TerminalManager(
    (_connectionId, message) => delivered.push(message),
    async () => createFactory(spawned),
  );

  await manager.create(createOptions({
    launchSpec: { program: 'claude' },
    providerId: 'claude-code',
    appearanceChangePolicy: 'live',
    appearance: {
      mode: 'light',
      foreground: '#25282b',
      background: '#fafaf9',
    },
  }));
  await manager.create(createOptions({
    terminalId: 'second-surface-proposal',
    connectionId: 'connection-b',
    surfaceId: 'surface-b',
    appearance: {
      mode: 'light',
      foreground: '#25282b',
      background: '#fafaf9',
    },
  }));
  delivered.length = 0;

  spawned[0].emitData('\x1b[?2031h');
  manager.setAppearance(
    'terminal-a',
    'user-a',
    'connection-a',
    'surface-a',
    { mode: 'dark', foreground: '#e3e9ed', background: '#161616' },
  );

  assert.deepEqual(spawned[0].writes, [
    '\x1b[?997;2n',
    '\x1b[?997;1n',
  ]);
  assert.ok(delivered.some((message) => (
    message.type === 'terminal_appearance'
    && message.appearance.mode === 'dark'
    && message.restartRequired === false
  )));
  assert.equal(
    delivered.filter((message) => (
      message.type === 'terminal_appearance'
      && message.appearance.mode === 'dark'
    )).length,
    2,
  );

  await manager.shutdownAll();
});

test('running Codex keeps its launch appearance and requests restart when it cannot subscribe', async () => {
  const delivered: ServerTransportMessage[] = [];
  const spawned: FakePty[] = [];
  let resumable = false;
  const manager = new TerminalManager(
    (_connectionId, message) => delivered.push(message),
    async () => createFactory(spawned),
  );

  await manager.create(createOptions({
    launchSpec: { program: 'codex' },
    providerId: 'codex',
    appearanceChangePolicy: 'restart',
    canRestartForAppearance: () => resumable,
    appearance: {
      mode: 'light',
      foreground: '#25282b',
      background: '#fafaf9',
    },
  }));
  delivered.length = 0;

  manager.setAppearance(
    'terminal-a',
    'user-a',
    'connection-a',
    'surface-a',
    { mode: 'dark', foreground: '#e3e9ed', background: '#161616' },
  );

  assert.deepEqual(spawned[0].writes, []);
  assert.ok(delivered.some((message) => (
    message.type === 'terminal_appearance'
    && message.appearance.mode === 'light'
    && message.restartRequired === true
    && message.restartAllowed === false
  )));

  delivered.length = 0;
  resumable = true;
  manager.refreshAppearanceRestartAvailability('session-a', 'user-a');
  assert.ok(delivered.some((message) => (
    message.type === 'terminal_appearance'
    && message.restartRequired === true
    && message.restartAllowed === true
  )));

  await manager.shutdownAll();
});

test('cold-attached Codex surface is told when its requested mode needs a restart', async () => {
  const delivered: Array<{ connectionId: string; message: ServerTransportMessage }> = [];
  const spawned: FakePty[] = [];
  const manager = new TerminalManager(
    (connectionId, message) => delivered.push({ connectionId, message }),
    async () => createFactory(spawned),
  );

  await manager.create(createOptions({
    launchSpec: { program: 'codex' },
    providerId: 'codex',
    appearanceChangePolicy: 'restart',
    canRestartForAppearance: () => true,
    appearanceRestartIntent: { kind: 'codex-slash', commandInput: '/resume' },
    appearance: {
      mode: 'light',
      foreground: '#25282b',
      background: '#fafaf9',
    },
  }));
  delivered.length = 0;

  await manager.create(createOptions({
    terminalId: 'different-client-proposal',
    connectionId: 'connection-b',
    surfaceId: 'surface-b',
    appearance: {
      mode: 'dark',
      foreground: '#e3e9ed',
      background: '#161616',
    },
  }));

  assert.ok(delivered.some(({ connectionId, message }) => (
    connectionId === 'connection-b'
    && message.type === 'terminal_appearance'
    && message.appearance.mode === 'light'
    && message.restartRequired === true
    && message.restartAllowed === true
    && message.restartIntent?.kind === 'codex-slash'
  )));

  await manager.shutdownAll();
});

test('a wedged headless model cannot freeze reattach: fallback snapshot then live output', async () => {
  const delivered: Array<{ connectionId: string; message: ServerTransportMessage }> = [];
  const spawned: FakePty[] = [];
  const deadline = (label: string) => new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error(label)), 1_000);
  });
  const manager = new TerminalManager(
    (connectionId, message) => delivered.push({ connectionId, message }),
    async () => createFactory(spawned),
    undefined,
    {
      snapshotTimeoutMs: 25,
      // A parser write whose completion callback never fires leaves the
      // model's write chain pending forever — snapshot() then never settles.
      createHeadlessModel: () => ({
        write: () => {},
        resize: () => {},
        snapshot: () => new Promise(() => {}),
        dispose: () => {},
      }),
    },
  );

  await Promise.race([manager.create(createOptions()), deadline('initial attach froze')]);
  spawned[0].emitData('history-before-park\r\n');
  await nextImmediate();

  delivered.length = 0;
  await Promise.race([
    manager.create(createOptions({ connectionId: 'connection-b', surfaceId: 'surface-b' })),
    deadline('reattach froze waiting for the wedged model snapshot'),
  ]);

  const snapshot = delivered.find(({ connectionId, message }) => (
    connectionId === 'connection-b' && message.type === 'terminal_snapshot'
  ))?.message;
  assert.equal(snapshot?.type, 'terminal_snapshot');
  if (snapshot?.type === 'terminal_snapshot') {
    assert.equal(snapshot.fallback, true, 'wedged model must degrade to the raw fallback snapshot');
    assert.match(snapshot.data, /history-before-park/);
  }

  delivered.length = 0;
  spawned[0].emitData('live-after-reattach');
  await nextImmediate();
  const liveForB = delivered
    .filter(({ connectionId, message }) => (
      connectionId === 'connection-b' && message.type === 'terminal_output'
    ))
    .map(({ message }) => (message.type === 'terminal_output' ? message.data : ''))
    .join('');
  assert.match(liveForB, /live-after-reattach/, 'live output must resume after the fallback snapshot');
});
