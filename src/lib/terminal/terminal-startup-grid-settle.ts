/**
 * Holds a terminal's first grid measurement until layout stops moving.
 *
 * The grid a surface measures on its first frame becomes the PTY's size, and
 * the PTY keeps it until something resizes it again. A pane measured mid-layout
 * — a window still booting, a tab mounting into a split that has not flexed yet
 * — reports a grid like 34x44 that no viewport ever had, and a session left
 * unrevealed after that never gets a correcting fit: the TUI draws at 34
 * columns for as long as it lives.
 *
 * So the spawn waits. A few frames of an unchanged measurement is weak evidence
 * on its own, which is why `minFrames` holds the window open even when the very
 * first measurement happens to be right, and `maxFrames` guarantees the spawn
 * still happens on a pane whose layout never settles.
 */

export type TerminalGridDimensions = { cols: number; rows: number };

export type TerminalStartupGridSettleOptions = {
  isAlive: () => boolean;
  /** Fit and read the pane's grid, or null while it cannot be measured. */
  measure: () => TerminalGridDimensions | null;
  /** Receives the settled grid, or null when nothing measurable was ever seen. */
  onSettled: (dimensions: TerminalGridDimensions | null) => void;
  requestFrame: (callback: () => void) => number;
  cancelFrame: (handle: number) => void;
  minFrames?: number;
  stableFrames?: number;
  maxFrames?: number;
};

export type TerminalStartupGridSettleHandle = { cancel: () => void };

/** Layout rarely finishes on frame one; this is the floor, not the target. */
const DEFAULT_MIN_FRAMES = 6;
/** Consecutive identical measurements that count as "layout stopped moving". */
const DEFAULT_STABLE_FRAMES = 2;
/** ~200ms at 60fps. A pane that never settles must still get its PTY. */
const DEFAULT_MAX_FRAMES = 12;

function isUsable(
  dimensions: TerminalGridDimensions | null,
): dimensions is TerminalGridDimensions {
  return Boolean(dimensions && dimensions.cols > 0 && dimensions.rows > 0);
}

function gridsEqual(
  a: TerminalGridDimensions | null,
  b: TerminalGridDimensions | null,
): boolean {
  return a?.cols === b?.cols && a?.rows === b?.rows;
}

export function waitForStableStartupGrid(
  options: TerminalStartupGridSettleOptions,
): TerminalStartupGridSettleHandle {
  const minFrames = Math.max(1, options.minFrames ?? DEFAULT_MIN_FRAMES);
  const stableFrames = Math.max(1, options.stableFrames ?? DEFAULT_STABLE_FRAMES);
  const maxFrames = Math.max(minFrames, options.maxFrames ?? DEFAULT_MAX_FRAMES);

  let frame = 0;
  let stableFrameCount = 0;
  let previous: TerminalGridDimensions | null = null;
  let latestUsable: TerminalGridDimensions | null = null;
  let pendingFrame: number | null = null;
  let finished = false;

  // Always fires, including for a surface that died mid-wait: callers await this
  // to decide whether to spawn, and a wait that can silently never resolve would
  // strand them. The caller re-checks liveness on the settled grid.
  const settle = (dimensions: TerminalGridDimensions | null): void => {
    if (finished) return;
    finished = true;
    pendingFrame = null;
    options.onSettled(dimensions);
  };

  const tick = (): void => {
    pendingFrame = null;
    if (finished) return;
    if (!options.isAlive()) {
      settle(latestUsable);
      return;
    }

    frame += 1;
    const measured = options.measure();
    if (isUsable(measured)) {
      latestUsable = measured;
      if (gridsEqual(previous, measured)) {
        stableFrameCount += 1;
      } else {
        previous = measured;
        stableFrameCount = 1;
      }
    } else {
      // An unmeasurable frame is not a stable one: layout is not ready yet.
      stableFrameCount = 0;
    }

    const settledEarly =
      latestUsable !== null && frame >= minFrames && stableFrameCount >= stableFrames;
    if (settledEarly || frame >= maxFrames) {
      settle(latestUsable);
      return;
    }
    pendingFrame = options.requestFrame(tick);
  };

  pendingFrame = options.requestFrame(tick);

  return {
    cancel: () => {
      finished = true;
      if (pendingFrame !== null) {
        options.cancelFrame(pendingFrame);
        pendingFrame = null;
      }
    },
  };
}
