import assert from 'node:assert/strict';
import test from 'node:test';
import {
  scheduleTerminalScrollIntentSync,
  TerminalScrollController,
  type TerminalScrollScheduler,
  type TerminalScrollTarget,
} from '@/lib/terminal/terminal-scroll-controller';
import { LayoutSettleRunner } from '@/lib/terminal/layout-settle-runner';

function createScheduler() {
  let nextId = 1;
  const frames = new Map<number, () => void>();
  const timers = new Map<number, () => void>();
  const scheduler: TerminalScrollScheduler = {
    cancelAnimationFrame: (id) => frames.delete(id),
    clearTimeout: (id) => timers.delete(id),
    queueMicrotask: (callback) => callback(),
    requestAnimationFrame: (callback) => {
      const id = nextId++;
      frames.set(id, callback);
      return id;
    },
    setTimeout: (callback) => {
      const id = nextId++;
      timers.set(id, callback);
      return id;
    },
  };
  return {
    scheduler,
    runNextFrame: () => {
      const entry = frames.entries().next().value as [number, () => void] | undefined;
      assert.ok(entry);
      frames.delete(entry[0]);
      entry[1]();
    },
    runNextTimer: () => {
      const entry = timers.entries().next().value as [number, () => void] | undefined;
      assert.ok(entry);
      timers.delete(entry[0]);
      entry[1]();
    },
  };
}

function createTarget(overrides: Partial<TerminalScrollTarget['buffer']['active']> = {}) {
  const calls: Array<{ type: 'bottom' } | { type: 'line'; line: number }> = [];
  const markerOffsets: number[] = [];
  let markerDisposed = false;
  let markerLine = overrides.viewportY ?? 200;
  const active = {
    type: 'normal' as const,
    baseY: 200,
    viewportY: 200,
    cursorY: 20,
    ...overrides,
  };
  const target: TerminalScrollTarget = {
    buffer: { active },
    scrollToBottom: () => {
      active.viewportY = active.baseY;
      calls.push({ type: 'bottom' });
    },
    scrollToLine: (line) => {
      active.viewportY = line;
      calls.push({ type: 'line', line });
    },
    registerMarker: (offset = 0) => {
      markerOffsets.push(offset);
      return {
        get isDisposed() {
          return markerDisposed;
        },
        get line() {
          return markerLine;
        },
        dispose: () => {
          markerDisposed = true;
        },
      };
    },
  };
  return {
    active,
    calls,
    markerOffsets,
    setMarkerLine: (line: number) => {
      markerLine = line;
    },
    target,
    wasMarkerDisposed: () => markerDisposed,
  };
}

test('follow-output intent remains attached to live output after terminal reflow', () => {
  const { active, calls, target } = createTarget();
  const controller = new TerminalScrollController(target);
  const restorePoint = controller.captureRestorePoint();

  active.baseY = 260;
  active.viewportY = 175;
  controller.restore(restorePoint);

  assert.deepEqual(calls, [{ type: 'bottom' }]);
  assert.equal(active.viewportY, 260);
  assert.deepEqual(controller.getSnapshot(), {
    intent: 'follow-output',
    isAtBottom: true,
  });
});

test('pinned viewport follows the same first visible line through wrapped-line reflow', () => {
  const {
    active,
    calls,
    markerOffsets,
    setMarkerLine,
    target,
    wasMarkerDisposed,
  } = createTarget({ viewportY: 150 });
  const controller = new TerminalScrollController(target);
  const restorePoint = controller.captureRestorePoint();

  assert.deepEqual(markerOffsets, [-70]);
  setMarkerLine(185);
  active.baseY = 260;
  active.viewportY = 260;
  controller.restore(restorePoint);

  assert.deepEqual(calls, [{ type: 'line', line: 185 }]);
  assert.equal(active.viewportY, 185);
  assert.equal(wasMarkerDisposed(), true);
  assert.deepEqual(controller.getSnapshot(), {
    intent: 'pinned-viewport',
    isAtBottom: false,
  });
});

test('a pinned viewport keeps its bottom offset while a TUI rebuilds the buffer', () => {
  const { active, calls, markerOffsets, target } = createTarget({ viewportY: 150 });
  const controller = new TerminalScrollController(target);
  const beforeClear = controller.captureRestorePoint();

  active.baseY = 0;
  active.viewportY = 0;
  const duringRebuild = controller.captureRestorePoint();
  beforeClear.marker?.dispose();
  controller.restore(beforeClear);

  active.baseY = 120;
  active.viewportY = 0;
  controller.restore(duringRebuild);

  assert.deepEqual(calls, [
    { type: 'line', line: 0 },
    { type: 'line', line: 70 },
  ]);
  assert.deepEqual(markerOffsets, [-70]);
  assert.equal(active.viewportY, 70);
});

test('a user follow-output request wins over an older pinned restore point', () => {
  const { active, calls, setMarkerLine, target, wasMarkerDisposed } = createTarget({
    viewportY: 150,
  });
  const controller = new TerminalScrollController(target);
  const staleRestorePoint = controller.captureRestorePoint();

  setMarkerLine(120);
  controller.scrollToBottom();
  controller.restore(staleRestorePoint);

  assert.deepEqual(calls, [{ type: 'bottom' }]);
  assert.equal(active.viewportY, active.baseY);
  assert.equal(wasMarkerDisposed(), true);
  assert.deepEqual(controller.getSnapshot(), {
    intent: 'follow-output',
    isAtBottom: true,
  });
});

test('layout restore follows a marker until xterm reflow has settled', () => {
  const { calls, setMarkerLine, target, wasMarkerDisposed } = createTarget({ viewportY: 150 });
  const { scheduler, runNextFrame, runNextTimer } = createScheduler();
  const controller = new TerminalScrollController(target, scheduler);
  const restorePoint = controller.captureRestorePoint();

  setMarkerLine(170);
  controller.restoreAfterLayout(restorePoint);
  setMarkerLine(180);
  runNextFrame();
  setMarkerLine(190);
  runNextFrame();
  setMarkerLine(200);
  runNextTimer();

  assert.deepEqual(calls, [
    { type: 'line', line: 170 },
    { type: 'line', line: 180 },
    { type: 'line', line: 190 },
    { type: 'line', line: 200 },
  ]);
  assert.equal(wasMarkerDisposed(), true);
});

test('viewport tracking distinguishes deliberate history reading from following output', () => {
  const { active, target } = createTarget();
  const controller = new TerminalScrollController(target);
  let notifications = 0;
  controller.subscribe(() => {
    notifications += 1;
  });

  active.viewportY = 150;
  controller.syncFromViewport();
  assert.deepEqual(controller.getSnapshot(), {
    intent: 'pinned-viewport',
    isAtBottom: false,
  });

  active.viewportY = active.baseY;
  controller.syncFromViewport({ preservePinnedAtBottom: true });
  assert.deepEqual(controller.getSnapshot(), {
    intent: 'pinned-viewport',
    isAtBottom: true,
  });

  controller.syncFromViewport();
  assert.deepEqual(controller.getSnapshot(), {
    intent: 'follow-output',
    isAtBottom: true,
  });
  assert.equal(notifications, 3);
});

test('explicit scrollback navigation updates both viewport and output-following intent', () => {
  const { active, calls, target } = createTarget();
  const controller = new TerminalScrollController(target);

  controller.scrollToTop();
  assert.deepEqual(calls, [{ type: 'line', line: 0 }]);
  assert.deepEqual(controller.getSnapshot(), {
    intent: 'pinned-viewport',
    isAtBottom: false,
  });

  controller.scrollToBottom();
  assert.equal(active.viewportY, active.baseY);
  assert.deepEqual(controller.getSnapshot(), {
    intent: 'follow-output',
    isAtBottom: true,
  });
});

test('wheel-up intent pins immediately before the browser viewport catches up', () => {
  const { active, target } = createTarget();
  const controller = new TerminalScrollController(target);

  controller.pinViewport();
  assert.deepEqual(controller.getSnapshot(), {
    intent: 'pinned-viewport',
    isAtBottom: true,
  });

  active.viewportY = 150;
  controller.syncFromViewport({ preservePinnedAtBottom: true });
  assert.deepEqual(controller.getSnapshot(), {
    intent: 'pinned-viewport',
    isAtBottom: false,
  });
});

test('a wheel consumed by a TUI does not leave a phantom pin at the bottom', () => {
  const { target } = createTarget();
  const { scheduler, runNextTimer } = createScheduler();
  const controller = new TerminalScrollController(target);

  controller.pinViewport();
  scheduleTerminalScrollIntentSync(
    controller,
    new LayoutSettleRunner(scheduler),
    true,
  );

  assert.equal(controller.getSnapshot().intent, 'pinned-viewport');
  runNextTimer();
  assert.equal(controller.getSnapshot().intent, 'follow-output');
});

test('settled wheel tracking keeps a viewport that actually moved pinned', () => {
  const { active, target } = createTarget();
  const { scheduler, runNextTimer } = createScheduler();
  const controller = new TerminalScrollController(target);

  controller.pinViewport();
  scheduleTerminalScrollIntentSync(
    controller,
    new LayoutSettleRunner(scheduler),
    true,
  );
  active.viewportY = 150;
  runNextTimer();

  assert.deepEqual(controller.getSnapshot(), {
    intent: 'pinned-viewport',
    isAtBottom: false,
  });
});

test('programmatic viewport movement updates visibility without overwriting intent', () => {
  const { active, target } = createTarget();
  const controller = new TerminalScrollController(target);

  active.viewportY = 150;
  controller.notifyViewportChanged();

  assert.deepEqual(controller.getSnapshot(), {
    intent: 'follow-output',
    isAtBottom: false,
  });
});

test('restore tolerates xterm renderer teardown and still releases its marker', () => {
  const { target, wasMarkerDisposed } = createTarget({ viewportY: 150 });
  const controller = new TerminalScrollController(target);
  const restorePoint = controller.captureRestorePoint();
  target.scrollToLine = () => {
    throw new TypeError("Cannot read properties of undefined (reading 'dimensions')");
  };

  assert.doesNotThrow(() => controller.restore(restorePoint));
  assert.equal(wasMarkerDisposed(), true);
});
