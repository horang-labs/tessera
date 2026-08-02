import assert from 'node:assert/strict';
import test from 'node:test';
import {
  TerminalSurface,
  type TerminalSurfaceSnapshot,
} from '@/lib/terminal/terminal-surface-registry';
import { getTerminalTheme } from '@/lib/terminal/terminal-theme';
import { wsClient } from '@/lib/ws/client';
import type { ServerTransportMessage } from '@/lib/ws/message-types';

interface ReplayTestTerminal {
  cols: number;
  element?: { contains(value: unknown): boolean };
  rows: number;
  options: Record<string, unknown>;
  modes: { sendFocusMode: boolean };
  pendingCallbacks: Array<() => void>;
  writes: string[];
  dispose(): void;
  flushNextWrite(): void;
  flushWrites(): void;
  reset(): void;
  resize(cols: number, rows: number): void;
  refresh(): void;
  write(data: string, callback?: () => void): void;
}

interface ReplayTestSurfaceInternals {
  attachedConnectionGeneration: number;
  fitAddon: {
    fit(): void;
    proposeDimensions(): { cols: number; rows: number };
  };
  handleServerMessage(message: ServerTransportMessage): void;
  ensureConnected(): Promise<boolean>;
  mount(host: HTMLElement): Promise<void>;
  mountedHost: HTMLElement;
  state: TerminalSurfaceSnapshot;
  terminal: ReplayTestTerminal;
}

function createTerminal(
  completeWrites: boolean,
  onDispose: () => void,
): ReplayTestTerminal {
  const pendingCallbacks: Array<() => void> = [];
  return {
    cols: 80,
    element: undefined,
    rows: 24,
    options: {},
    modes: { sendFocusMode: false },
    pendingCallbacks,
    writes: [],
    dispose: onDispose,
    flushNextWrite() {
      pendingCallbacks.shift()?.();
    },
    flushWrites() {
      while (pendingCallbacks.length > 0) pendingCallbacks.shift()?.();
    },
    reset() {},
    resize(cols, rows) {
      this.cols = cols;
      this.rows = rows;
    },
    refresh() {},
    write(data, callback) {
      this.writes.push(data);
      if (!callback) return;
      const complete = () => {
        if (data.includes('\x1b[?1004h')) this.modes.sendFocusMode = true;
        if (data.includes('\x1b[?1004l')) this.modes.sendFocusMode = false;
        callback();
      };
      if (completeWrites) complete();
      else pendingCallbacks.push(complete);
    },
  };
}

function createSurfaceHarness(options: { initiallyVisible: boolean; completeWrites?: boolean }) {
  let visible = options.initiallyVisible;
  const animationFrames: FrameRequestCallback[] = [];
  const timers = new Map<number, () => void>();
  let nextTimerId = 1;
  let disposedTerminals = 0;
  let remounts = 0;
  const activeElement = {};
  const testDocument = { activeElement: null as object | null };
  const originalWindow = globalThis.window;
  const originalDocument = globalThis.document;
  const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
  const originalCancelAnimationFrame = globalThis.cancelAnimationFrame;
  const originalSendTerminalInput = wsClient.sendTerminalInput;
  const originalDetachTerminal = wsClient.detachTerminal;

  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      clearTimeout: (id: number) => timers.delete(id),
      setTimeout: (callback: () => void) => {
        const id = nextTimerId;
        nextTimerId += 1;
        timers.set(id, callback);
        return id;
      },
    },
  });
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: testDocument,
  });
  Object.defineProperty(globalThis, 'requestAnimationFrame', {
    configurable: true,
    value: (callback: FrameRequestCallback) => {
      animationFrames.push(callback);
      return animationFrames.length;
    },
  });
  Object.defineProperty(globalThis, 'cancelAnimationFrame', {
    configurable: true,
    value: () => {},
  });

  const surface = new TerminalSurface({
    registryKey: 'replay-lifecycle-test',
    terminalId: 'replay-lifecycle-test',
    theme: getTerminalTheme(true),
    appearanceMode: 'dark',
    fontSize: 14,
  });
  let terminal = createTerminal(options.completeWrites ?? true, () => {
    disposedTerminals += 1;
  });
  const host = {
    isConnected: true,
    closest: () => (visible ? null : {}),
    getBoundingClientRect: () => ({
      width: visible ? 800 : 0,
      height: visible ? 600 : 0,
    }),
  } as unknown as HTMLElement;
  const internals = surface as unknown as ReplayTestSurfaceInternals;
  internals.terminal = terminal;
  internals.fitAddon = {
    fit() {},
    proposeDimensions: () => ({ cols: terminal.cols, rows: terminal.rows }),
  };
  internals.mountedHost = host;
  internals.attachedConnectionGeneration = 1;
  internals.state = { ...internals.state, status: 'running' };

  const deliveredInput: string[] = [];
  wsClient.sendTerminalInput = (_terminalId, _surfaceId, data) => {
    deliveredInput.push(data);
    return true;
  };
  wsClient.detachTerminal = () => true;

  const flushAnimationFrames = () => {
    while (animationFrames.length > 0) {
      const callbacks = animationFrames.splice(0, animationFrames.length);
      for (const callback of callbacks) callback(0);
    }
  };
  const flushTimers = () => {
    while (timers.size > 0) {
      const callbacks = [...timers.values()];
      timers.clear();
      for (const callback of callbacks) callback();
    }
  };

  const send = (message: ServerTransportMessage) => internals.handleServerMessage(message);
  send({
    type: 'terminal_started',
    terminalId: 'replay-lifecycle-test',
    surfaceId: surface.surfaceId,
    generation: 1,
    cwd: '/tmp',
    shell: 'test-shell',
    reattached: true,
  });

  return {
    deliveredInput,
    get disposedTerminals() {
      return disposedTerminals;
    },
    flushAnimationFrames,
    flushTimers,
    installRemountProbe() {
      internals.mount = async () => {
        remounts += 1;
      };
      internals.ensureConnected = async () => true;
    },
    get remounts() {
      return remounts;
    },
    replaceTerminal(completeWrites: boolean) {
      terminal = createTerminal(completeWrites, () => {
        disposedTerminals += 1;
      });
      internals.terminal = terminal;
      internals.fitAddon = {
        fit() {},
        proposeDimensions: () => ({ cols: terminal.cols, rows: terminal.rows }),
      };
      internals.attachedConnectionGeneration = 1;
    },
    focusTerminal() {
      testDocument.activeElement = activeElement;
      terminal.element = { contains: (value) => value === activeElement };
    },
    reveal() {
      visible = true;
      surface.setHostVisible(true);
    },
    send,
    surface,
    get terminal() {
      return terminal;
    },
    restore() {
      wsClient.sendTerminalInput = originalSendTerminalInput;
      wsClient.detachTerminal = originalDetachTerminal;
      surface.dispose({ detach: false });
      flushTimers();
      Object.defineProperty(globalThis, 'window', {
        configurable: true,
        value: originalWindow,
      });
      Object.defineProperty(globalThis, 'document', {
        configurable: true,
        value: originalDocument,
      });
      Object.defineProperty(globalThis, 'requestAnimationFrame', {
        configurable: true,
        value: originalRequestAnimationFrame,
      });
      Object.defineProperty(globalThis, 'cancelAnimationFrame', {
        configurable: true,
        value: originalCancelAnimationFrame,
      });
    },
  };
}

function snapshot(
  surfaceId: string,
  options: { data?: string; seq?: number } = {},
): ServerTransportMessage {
  return {
    type: 'terminal_snapshot',
    terminalId: 'replay-lifecycle-test',
    surfaceId,
    generation: 1,
    seq: options.seq ?? 1,
    data: options.data ?? 'SNAPSHOT',
    cols: 80,
    rows: 24,
  };
}

test('input response is not stranded when a parsed snapshot is revealed', () => {
  const harness = createSurfaceHarness({ initiallyVisible: false });
  try {
    harness.send(snapshot(harness.surface.surfaceId));

    assert.equal(harness.surface.sendInput('\x1b[B'), true);
    assert.deepEqual(harness.deliveredInput, ['\x1b[B']);

    harness.send({
      type: 'terminal_output',
      terminalId: 'replay-lifecycle-test',
      surfaceId: harness.surface.surfaceId,
      generation: 1,
      seq: 2,
      data: 'SELECT_2',
    });
    const writesBeforeReveal = harness.terminal.writes.filter(Boolean);
    assert.match(writesBeforeReveal[0], /SNAPSHOT$/);
    assert.equal(writesBeforeReveal.at(-1), 'SELECT_2');

    harness.reveal();
    harness.flushAnimationFrames();

    assert.equal(
      harness.terminal.writes.filter(Boolean).at(-1),
      'SELECT_2',
      'input must not appear ignored until an unrelated resize eventually releases its output',
    );
  } finally {
    harness.restore();
  }
});

test('the actual snapshot transition blocks input only until xterm finishes parsing', () => {
  const harness = createSurfaceHarness({ initiallyVisible: true, completeWrites: false });
  try {
    harness.send(snapshot(harness.surface.surfaceId));
    assert.equal(harness.surface.sendInput('AUTO_REPLY_DURING_PARSE'), false);
    assert.deepEqual(harness.deliveredInput, []);

    harness.terminal.flushWrites();
    assert.equal(harness.surface.sendInput('\x1b[B'), true);
    assert.deepEqual(harness.deliveredInput, ['\x1b[B']);
  } finally {
    harness.restore();
  }
});

test('live output enters xterm FIFO while snapshot fit is still pending', () => {
  const harness = createSurfaceHarness({ initiallyVisible: true });
  try {
    harness.send(snapshot(harness.surface.surfaceId));
    harness.send({
      type: 'terminal_output',
      terminalId: 'replay-lifecycle-test',
      surfaceId: harness.surface.surfaceId,
      generation: 1,
      seq: 2,
      data: 'LIVE_AFTER_SNAPSHOT',
    });

    assert.equal(
      harness.terminal.writes.at(-1),
      'LIVE_AFTER_SNAPSHOT',
      'xterm write ordering is the replay barrier; fit must not hide live output',
    );
  } finally {
    harness.restore();
  }
});

test('a wedged snapshot write remounts instead of blocking input forever', async () => {
  const harness = createSurfaceHarness({ initiallyVisible: true, completeWrites: false });
  harness.installRemountProbe();
  try {
    harness.send(snapshot(harness.surface.surfaceId));
    assert.equal(harness.surface.sendInput('\x1b[B'), false);

    harness.flushTimers();
    await Promise.resolve();
    await Promise.resolve();

    assert.equal(harness.disposedTerminals, 1);
    assert.equal(harness.remounts, 1);
  } finally {
    harness.restore();
  }
});

test('a repeated parser stall stops automatic recovery until an explicit restart', async () => {
  const harness = createSurfaceHarness({ initiallyVisible: true, completeWrites: false });
  harness.installRemountProbe();
  try {
    harness.send(snapshot(harness.surface.surfaceId));
    harness.flushTimers();
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(harness.remounts, 1);

    harness.replaceTerminal(false);
    harness.send(snapshot(harness.surface.surfaceId, { seq: 2 }));
    harness.flushTimers();

    assert.equal(harness.remounts, 1);
    assert.equal(harness.surface.getSnapshot().status, 'error');

    assert.equal(await harness.surface.restart(), true);
    harness.replaceTerminal(false);
    harness.send(snapshot(harness.surface.surfaceId));
    harness.flushTimers();
    await Promise.resolve();
    await Promise.resolve();

    assert.equal(
      harness.remounts,
      2,
      'an explicit restart must grant the fresh renderer one bounded recovery attempt',
    );
  } finally {
    harness.restore();
  }
});

test('the FIFO fence completes replay when the snapshot callback itself is lost', () => {
  const harness = createSurfaceHarness({ initiallyVisible: true, completeWrites: false });
  harness.installRemountProbe();
  let writeCount = 0;
  harness.terminal.write = function write(data, callback) {
    this.writes.push(data);
    writeCount += 1;
    if (writeCount > 1) callback?.();
  };
  try {
    harness.send(snapshot(harness.surface.surfaceId));

    assert.equal(harness.surface.sendInput('\x1b[B'), true);
    harness.flushTimers();
    assert.equal(harness.remounts, 0);
  } finally {
    harness.restore();
  }
});

test('a replacement snapshot invalidates callbacks from the previous replay', () => {
  const harness = createSurfaceHarness({ initiallyVisible: true, completeWrites: false });
  try {
    harness.send(snapshot(harness.surface.surfaceId, { data: 'OLD_SNAPSHOT', seq: 1 }));
    harness.send(snapshot(harness.surface.surfaceId, { data: 'NEW_SNAPSHOT', seq: 2 }));
    harness.terminal.flushWrites();

    assert.equal(harness.surface.sendInput('\x1b[B'), true);
    assert.match(
      harness.terminal.writes.filter(Boolean).at(-1) ?? '',
      /NEW_SNAPSHOT$/,
    );
  } finally {
    harness.restore();
  }
});

test('terminal exit cancels replay recovery and leaves no stale remount', async () => {
  const harness = createSurfaceHarness({ initiallyVisible: true, completeWrites: false });
  harness.installRemountProbe();
  try {
    harness.send(snapshot(harness.surface.surfaceId));
    harness.send({
      type: 'terminal_exit',
      terminalId: 'replay-lifecycle-test',
      surfaceId: harness.surface.surfaceId,
      generation: 1,
      exitCode: 0,
    });

    harness.flushTimers();
    await Promise.resolve();
    assert.equal(harness.remounts, 0);
    assert.equal(harness.surface.getSnapshot().status, 'exited');
  } finally {
    harness.restore();
  }
});

test('focus reporting waits for live output already queued behind the snapshot', () => {
  const harness = createSurfaceHarness({ initiallyVisible: true, completeWrites: false });
  harness.focusTerminal();
  try {
    harness.send(snapshot(harness.surface.surfaceId));
    harness.terminal.flushWrites();
    harness.send({
      type: 'terminal_output',
      terminalId: 'replay-lifecycle-test',
      surfaceId: harness.surface.surfaceId,
      generation: 1,
      seq: 2,
      data: '\x1b[?1004h',
    });

    harness.flushAnimationFrames();
    assert.deepEqual(harness.deliveredInput, []);

    harness.terminal.flushWrites();
    assert.deepEqual(harness.deliveredInput, ['\x1b[I']);
  } finally {
    harness.restore();
  }
});
