import assert from 'node:assert/strict';
import test from 'node:test';
import {
  TerminalSurface,
  type TerminalSurfaceSnapshot,
} from '@/lib/terminal/terminal-surface-registry';
import { getTerminalTheme } from '@/lib/terminal/terminal-theme';
import { wsClient } from '@/lib/ws/client';
import type { ServerTransportMessage } from '@/lib/ws/message-types';

/**
 * The reported failure, end to end: a session whose PTY was spawned at 34x44
 * before its pane had laid out, reopened later in a full-width pane. The
 * snapshot arrives at the PTY's narrow grid, the replay pins xterm to it, and
 * nothing afterwards brings the two back together — the pane renders 34 columns
 * of a TUI that is drawing at 178 until the user drags a divider.
 */

type SurfaceInternals = {
  attachedConnectionGeneration: number;
  fitAddon: { fit(): void; proposeDimensions(): { cols: number; rows: number } };
  handleServerMessage(message: ServerTransportMessage): void;
  lastRequestedGrid: { cols: number; rows: number } | null;
  mountedHost: HTMLElement;
  pendingFitFrameId: number | null;
  state: TerminalSurfaceSnapshot;
  terminal: FakeTerminal;
};

type FakeTerminal = {
  cols: number;
  rows: number;
  options: Record<string, unknown>;
  modes: { sendFocusMode: boolean };
  element?: { contains(value: unknown): boolean };
  writes: string[];
  dispose(): void;
  reset(): void;
  resize(cols: number, rows: number): void;
  refresh(): void;
  write(data: string, callback?: () => void): void;
};

function createHarness(paneGrid: { cols: number; rows: number }) {
  const animationFrames: FrameRequestCallback[] = [];
  const timers = new Map<number, () => void>();
  let nextTimerId = 1;

  const originalWindow = globalThis.window;
  const originalDocument = globalThis.document;
  const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
  const originalCancelAnimationFrame = globalThis.cancelAnimationFrame;
  const originalResizeTerminal = wsClient.resizeTerminal;
  const originalDetachTerminal = wsClient.detachTerminal;
  const originalSendTerminalInput = wsClient.sendTerminalInput;

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
    value: { activeElement: null },
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

  const terminal: FakeTerminal = {
    cols: 80,
    rows: 24,
    options: {},
    modes: { sendFocusMode: false },
    writes: [],
    dispose() {},
    reset() {},
    resize(cols, rows) {
      this.cols = cols;
      this.rows = rows;
    },
    refresh() {},
    write(data, callback) {
      this.writes.push(data);
      callback?.();
    },
  };

  const surface = new TerminalSurface({
    registryKey: 'grid-recovery-test',
    terminalId: 'grid-recovery-test',
    theme: getTerminalTheme(true),
    appearanceMode: 'dark',
    fontSize: 14,
  });
  const internals = surface as unknown as SurfaceInternals;
  internals.terminal = terminal;
  internals.fitAddon = {
    // A real fit brings xterm to the container's grid; the proposal is the
    // pane's, which is exactly what the snapshot replay does not respect.
    fit() {
      terminal.resize(paneGrid.cols, paneGrid.rows);
    },
    proposeDimensions: () => ({ ...paneGrid }),
  };
  internals.mountedHost = {
    isConnected: true,
    closest: () => null,
    getBoundingClientRect: () => ({ width: 1600, height: 900 }),
  } as unknown as HTMLElement;
  internals.attachedConnectionGeneration = 1;
  // What ensureConnected sent with the create request — the grid the surface
  // believes it already asked for, and where the reconcile starts counting.
  internals.lastRequestedGrid = { ...paneGrid };
  internals.state = { ...internals.state, status: 'running' };

  const forwarded: Array<{ cols: number; rows: number }> = [];
  wsClient.resizeTerminal = (_terminalId, _surfaceId, cols, rows) => {
    forwarded.push({ cols, rows });
    return true;
  };
  wsClient.detachTerminal = () => true;
  wsClient.sendTerminalInput = () => true;

  return {
    forwarded,
    surface,
    terminal,
    send: (message: ServerTransportMessage) => internals.handleServerMessage(message),
    /**
     * Swallow the post-replay fit the way a live surface can.
     * `requestStableFit` returns early whenever a fit chain is already in
     * flight, so a chain started by the reveal that is still walking frames
     * when the replay finishes eats the one request that would have brought
     * xterm off the snapshot's grid. Nothing retries it.
     */
    withFitRequestLost(run: () => void): void {
      const previous = internals.pendingFitFrameId;
      internals.pendingFitFrameId = 999;
      try {
        run();
      } finally {
        internals.pendingFitFrameId = previous;
      }
    },
    /** Bounded so a reconcile that never settles fails the test instead of hanging it. */
    runFrames(limit = 400): number {
      let ran = 0;
      while (animationFrames.length > 0 && ran < limit) {
        const callbacks = animationFrames.splice(0, animationFrames.length);
        for (const callback of callbacks) {
          callback(0);
          ran += 1;
        }
      }
      return ran;
    },
    restore() {
      wsClient.resizeTerminal = originalResizeTerminal;
      wsClient.detachTerminal = originalDetachTerminal;
      wsClient.sendTerminalInput = originalSendTerminalInput;
      surface.dispose({ detach: false });
      timers.clear();
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

function startedMessage(surfaceId: string): ServerTransportMessage {
  return {
    type: 'terminal_started',
    terminalId: 'grid-recovery-test',
    surfaceId,
    generation: 1,
    cwd: '/tmp',
    shell: 'test-shell',
    reattached: true,
  };
}

test('reattaching to a PTY stranded on a narrow grid recovers both grids', () => {
  const harness = createHarness({ cols: 178, rows: 57 });
  try {
    harness.send(startedMessage(harness.surface.surfaceId));
    // The server reports the grid the PTY is really on — the one it was spawned
    // at ten minutes ago, in a pane that had not laid out yet.
    harness.send({
      type: 'terminal_grid',
      terminalId: 'grid-recovery-test',
      surfaceId: harness.surface.surfaceId,
      cols: 34,
      rows: 44,
      accepted: true,
    });
    // With the replay's own fit request lost, the reconcile is the only thing
    // left that can notice xterm and the pane disagree.
    harness.withFitRequestLost(() => {
      harness.send({
        type: 'terminal_snapshot',
        terminalId: 'grid-recovery-test',
        surfaceId: harness.surface.surfaceId,
        generation: 1,
        seq: 9,
        data: 'narrow-snapshot',
        cols: 34,
        rows: 44,
      });
    });

    // The replay put xterm on the snapshot's grid, as it must to reproduce the
    // serialized rows faithfully.
    assert.deepEqual(
      { cols: harness.terminal.cols, rows: harness.terminal.rows },
      { cols: 34, rows: 44 },
    );

    harness.runFrames();

    assert.deepEqual(
      { cols: harness.terminal.cols, rows: harness.terminal.rows },
      { cols: 178, rows: 57 },
      'xterm was left on the snapshot grid',
    );
    assert.ok(
      harness.forwarded.some((grid) => grid.cols === 178 && grid.rows === 57),
      'the PTY was never told the pane is 178 columns wide',
    );
  } finally {
    harness.restore();
  }
});

test('a pane already in step with its PTY settles without churning resizes', () => {
  const harness = createHarness({ cols: 120, rows: 40 });
  try {
    harness.terminal.resize(120, 40);
    harness.send(startedMessage(harness.surface.surfaceId));
    harness.send({
      type: 'terminal_grid',
      terminalId: 'grid-recovery-test',
      surfaceId: harness.surface.surfaceId,
      cols: 120,
      rows: 40,
      accepted: true,
    });

    const frames = harness.runFrames();

    assert.deepEqual(harness.forwarded, [], 'resized a PTY that already agreed');
    // Settling on the echo rather than running out the frame cap: the loop must
    // not keep a rAF chain alive for three seconds on every attach.
    assert.ok(frames < 60, `reconcile ran ${frames} frames before settling`);
  } finally {
    harness.restore();
  }
});
