import assert from 'node:assert/strict';
import test from 'node:test';
import {
  waitForStableStartupGrid,
  type TerminalGridDimensions,
} from '@/lib/terminal/terminal-startup-grid-settle';

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

test('a grid that is still moving does not settle the startup measurement', () => {
  const loop = createFrameLoop();
  // The bug this guards: a window still booting reports a narrow pane for the
  // first frames, and that measurement used to become the PTY's size for good.
  const measurements: TerminalGridDimensions[] = [
    { cols: 34, rows: 44 },
    { cols: 34, rows: 44 },
    { cols: 91, rows: 52 },
    { cols: 178, rows: 57 },
  ];
  let index = 0;
  let settled: TerminalGridDimensions | null | undefined;

  waitForStableStartupGrid({
    isAlive: () => true,
    measure: () => measurements[Math.min(index++, measurements.length - 1)],
    onSettled: (grid) => {
      settled = grid;
    },
    requestFrame: loop.requestFrame,
    cancelFrame: loop.cancelFrame,
  });

  loop.run(3);
  assert.equal(settled, undefined, 'settled while the grid was still changing');

  loop.run(20);
  assert.deepEqual(settled, { cols: 178, rows: 57 });
});

test('a grid stable from the first frame still holds the minimum window', () => {
  const loop = createFrameLoop();
  let settled: TerminalGridDimensions | null | undefined;
  let measureCount = 0;

  waitForStableStartupGrid({
    isAlive: () => true,
    measure: () => {
      measureCount += 1;
      return { cols: 178, rows: 57 };
    },
    onSettled: (grid) => {
      settled = grid;
    },
    requestFrame: loop.requestFrame,
    cancelFrame: loop.cancelFrame,
    minFrames: 6,
  });

  loop.run(4);
  assert.equal(settled, undefined, 'settled before the minimum window elapsed');

  loop.run(10);
  assert.deepEqual(settled, { cols: 178, rows: 57 });
  assert.ok(measureCount >= 6);
});

test('an unmeasurable pane settles on null rather than waiting forever', () => {
  const loop = createFrameLoop();
  let settled: TerminalGridDimensions | null | undefined = { cols: 1, rows: 1 };

  waitForStableStartupGrid({
    isAlive: () => true,
    measure: () => null,
    onSettled: (grid) => {
      settled = grid;
    },
    requestFrame: loop.requestFrame,
    cancelFrame: loop.cancelFrame,
    maxFrames: 12,
  });

  loop.run(50);
  assert.equal(settled, null);
  assert.equal(loop.isRunning, false, 'kept scheduling frames after the cap');
});

test('a surface disposed mid-wait still resolves its caller', () => {
  const loop = createFrameLoop();
  let alive = true;
  let settledCalls = 0;

  waitForStableStartupGrid({
    isAlive: () => alive,
    measure: () => ({ cols: 120, rows: 40 }),
    onSettled: () => {
      settledCalls += 1;
    },
    requestFrame: loop.requestFrame,
    cancelFrame: loop.cancelFrame,
  });

  loop.run(2);
  alive = false;
  loop.run(1);

  // Callers await this to decide whether to spawn; a wait that never calls back
  // would strand ensureConnected forever.
  assert.equal(settledCalls, 1);
  assert.equal(loop.isRunning, false);
});
