import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { before } from 'node:test';
import type { ServerTransportMessage } from '@/lib/ws/message-types';
import type { TerminalCreateOptions, TerminalPtyFactory } from '@/lib/terminal/types';

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

test('a late exit from an older generation cannot erase its replacement runtime', async () => {
  const delivered: Array<{ connectionId: string; message: ServerTransportMessage }> = [];
  const spawned: FakePty[] = [];
  const manager = new TerminalManager(
    (connectionId, message) => delivered.push({ connectionId, message }),
    async () => createFactory(spawned),
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

  spawned[0].emitExit(0);
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
