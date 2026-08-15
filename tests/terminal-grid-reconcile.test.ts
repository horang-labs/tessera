import assert from 'node:assert/strict';
import test from 'node:test';
import {
  reconcileTerminalGrid,
  type TerminalGridAck,
  type TerminalGridDimensions,
  type TerminalGridReconcileReason,
} from '@/lib/terminal/terminal-grid-reconcile';

function createFrameLoop() {
  let queued: (() => void) | null = null;
  let nextHandle = 1;
  return {
    requestFrame: (callback: () => void) => {
      queued = callback;
      return nextHandle++;
    },
    cancelFrame: () => {
      queued = null;
    },
    run(frames: number): void {
      for (let i = 0; i < frames; i += 1) {
        const callback = queued;
        if (!callback) return;
        queued = null;
        callback();
      }
    },
    get isRunning(): boolean {
      return queued !== null;
    },
  };
}

type Harness = {
  forwarded: TerminalGridDimensions[];
  reason: TerminalGridReconcileReason | null;
};

function runReconcile(
  overrides: {
    initialGrid?: TerminalGridDimensions;
    /** Grid xterm starts on, when it differs from what was last requested. */
    initialRendererGrid?: TerminalGridDimensions;
    measure?: () => TerminalGridDimensions | null;
    isAuthoritative?: () => boolean;
    isAlive?: () => boolean;
    ackFor?: (sent: TerminalGridDimensions | null) => TerminalGridAck | null;
  },
  frames: number,
): Harness & { loop: ReturnType<typeof createFrameLoop> } {
  const loop = createFrameLoop();
  const harness: Harness = { forwarded: [], reason: null };
  const initialGrid = overrides.initialGrid ?? { cols: 34, rows: 44 };
  let lastForwarded: TerminalGridDimensions | null = null;
  // Stands in for fitAndResize: forwarding brings xterm across too.
  let rendererGrid: TerminalGridDimensions = overrides.initialRendererGrid ?? initialGrid;

  reconcileTerminalGrid({
    initialGrid,
    isAlive: overrides.isAlive ?? (() => true),
    isAuthoritative: overrides.isAuthoritative ?? (() => true),
    measure: overrides.measure ?? (() => ({ cols: 178, rows: 57 })),
    getRendererGrid: () => rendererGrid,
    forward: (grid) => {
      harness.forwarded.push(grid);
      lastForwarded = grid;
      rendererGrid = grid;
    },
    getAppliedGrid: () => (overrides.ackFor ?? defaultAck)(lastForwarded),
    requestFrame: loop.requestFrame,
    cancelFrame: loop.cancelFrame,
    onSettled: (reason) => {
      harness.reason = reason;
    },
  });

  loop.run(frames);
  return { ...harness, loop };
}

/** Server applied exactly what was last sent. */
const defaultAck = (sent: TerminalGridDimensions | null): TerminalGridAck | null =>
  sent === null ? null : { ...sent, accepted: true };

test('a corrected grid settles once the server echoes it back', () => {
  const result = runReconcile({}, 40);

  assert.equal(result.reason, 'verified');
  assert.deepEqual(result.forwarded, [{ cols: 178, rows: 57 }]);
  assert.equal(result.loop.isRunning, false);
});

test('a replay that stranded xterm on the snapshot grid is corrected, PTY agreement notwithstanding', () => {
  // The exact state behind the garbled pane: the PTY was resized to the pane's
  // grid and reports it, the container proposes that same grid, and the surface
  // has nothing new to send — but the snapshot replay pinned xterm to the grid
  // the snapshot was serialized at on its way in. Checking only "did the PTY
  // take what I last sent" calls this settled and leaves the pane rendering 34
  // columns of a 178-column TUI.
  const result = runReconcile(
    {
      initialGrid: { cols: 178, rows: 57 },
      initialRendererGrid: { cols: 34, rows: 44 },
      ackFor: () => ({ cols: 178, rows: 57, accepted: true }),
    },
    40,
  );

  assert.deepEqual(
    result.forwarded,
    [{ cols: 178, rows: 57 }],
    'left xterm on the snapshot grid while the TUI drew at the pane grid',
  );
  assert.equal(result.reason, 'verified');
});

test('a grid the PTY never applied is re-sent instead of being trusted', () => {
  // This is the failure the loop exists for: terminal_resize is fire-and-forget,
  // so a dropped request used to leave xterm wide while the TUI drew narrow.
  const result = runReconcile(
    { ackFor: () => ({ cols: 34, rows: 44, accepted: true }) },
    400,
  );

  assert.equal(result.reason, 'exhausted');
  // One for the measured change, then the bounded resends.
  assert.equal(result.forwarded.length, 4);
  for (const grid of result.forwarded) {
    assert.deepEqual(grid, { cols: 178, rows: 57 });
  }
  assert.equal(result.loop.isRunning, false);
});

test('losing the viewport to another surface stops the loop instead of fighting for it', () => {
  const result = runReconcile(
    { ackFor: () => ({ cols: 91, rows: 52, accepted: false }) },
    40,
  );

  assert.equal(result.reason, 'not-viewport-owner');
  assert.ok(
    result.forwarded.length <= 1,
    'kept forwarding after the server said another surface owns the viewport',
  );
});

test('a hidden pane never counts as settled, however steady its measurement', () => {
  const result = runReconcile({ isAuthoritative: () => false }, 400);

  // Steady-while-hidden is not evidence: nothing can measure the pane, so the
  // grid is unchanged for the same reason it is unverifiable.
  assert.equal(result.reason, 'exhausted');
});

test('every layout change is forwarded, and the last one wins', () => {
  const measurements: TerminalGridDimensions[] = [
    { cols: 60, rows: 50 },
    { cols: 120, rows: 55 },
    { cols: 178, rows: 57 },
  ];
  let index = 0;
  const result = runReconcile(
    {
      measure: () => measurements[Math.min(index++, measurements.length - 1)],
    },
    40,
  );

  assert.deepEqual(result.forwarded, measurements);
  assert.equal(result.reason, 'verified');
});

test('a surface torn down mid-loop stops scheduling frames', () => {
  const loop = createFrameLoop();
  let alive = true;
  let reason: TerminalGridReconcileReason | null = null;

  reconcileTerminalGrid({
    initialGrid: { cols: 34, rows: 44 },
    isAlive: () => alive,
    isAuthoritative: () => true,
    measure: () => ({ cols: 178, rows: 57 }),
    getRendererGrid: () => ({ cols: 178, rows: 57 }),
    forward: () => {},
    getAppliedGrid: () => null,
    requestFrame: loop.requestFrame,
    cancelFrame: loop.cancelFrame,
    onSettled: (settledReason) => {
      reason = settledReason;
    },
  });

  loop.run(3);
  alive = false;
  loop.run(2);

  assert.equal(reason, 'abandoned');
  assert.equal(loop.isRunning, false);
});

test('an unmeasurable pane forwards a usable default rather than staying blank', () => {
  const result = runReconcile(
    { initialGrid: { cols: 0, rows: 0 }, measure: () => null },
    400,
  );

  assert.equal(result.reason, 'exhausted');
  assert.deepEqual(result.forwarded, [{ cols: 80, rows: 24 }]);
});
