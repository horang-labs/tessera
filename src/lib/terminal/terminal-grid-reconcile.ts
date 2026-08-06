/**
 * Drives three grids to one value and verifies they got there.
 *
 * A terminal pane has three, and every one of them can drift on its own:
 *
 *   1. what the container wants  — FitAddon's proposal for the laid-out box
 *   2. what xterm renders at     — the grid the pane's buffer is actually in
 *   3. what the PTY draws at     — the size the TUI on the other end believes
 *
 * Nothing keeps them together by construction. A snapshot replay deliberately
 * pins (2) to the grid the snapshot was serialized at; `terminal_resize` is
 * fire-and-forget, so (3) silently keeps its old value when another surface
 * owns the viewport or the socket reconnects mid-flight. Either way the pane
 * ends up rendering one grid while the TUI draws at another — absolute cursor
 * motion lands in the wrong column, and the display stays garbled until the
 * user drags a divider and accidentally triggers the resize that should have
 * happened on attach.
 *
 * So this closes the loop over all three. Each frame it re-reads (1), forwards
 * whenever (2) or (3) has fallen out of step with it, and only settles once the
 * grid has held steady *and* the server has echoed back the same one it is
 * holding (`terminal_grid`). It tracks what it last *sent*, never what it hopes
 * was received.
 *
 * It always terminates: on a verified match, on losing viewport ownership, or
 * on the frame cap.
 */

import type { TerminalGridDimensions } from './terminal-startup-grid-settle';

export type { TerminalGridDimensions };

/** The server's last word on what the PTY is actually sized at. */
export type TerminalGridAck = TerminalGridDimensions & {
  /** False when another surface owns the viewport and our resize was dropped. */
  accepted: boolean;
};

export type TerminalGridReconcileReason =
  /** Measured grid held steady and the server echoed the same one back. */
  | 'verified'
  /** Another surface owns the viewport; this one has no say in the grid. */
  | 'not-viewport-owner'
  /** Frame cap hit without agreement. */
  | 'exhausted'
  /** The surface went away mid-loop. */
  | 'abandoned';

export type TerminalGridReconcileOptions = {
  /** Grid the surface asked for when it attached; what the PTY may already hold. */
  initialGrid: TerminalGridDimensions;
  isAlive: () => boolean;
  /**
   * True once this surface's measurements are trustworthy — mounted, visible,
   * and laid out. Frames measured while hidden still correct the PTY, but they
   * never count toward settling: a grid that is steady only because nothing can
   * measure it is not a settled grid.
   */
  isAuthoritative: () => boolean;
  /** The grid the container wants, or null while the pane cannot be measured. */
  measure: () => TerminalGridDimensions | null;
  /**
   * The grid xterm is currently rendering at. Checked separately from the PTY's
   * because a snapshot replay moves this one on its own — the replay resizes
   * xterm to the snapshot's grid — without the surface having asked for it.
   */
  getRendererGrid: () => TerminalGridDimensions | null;
  /**
   * Bring xterm and the PTY to this grid. Fire-and-forget as far as the PTY is
   * concerned; the echo is what proves that half landed.
   */
  forward: (grid: TerminalGridDimensions) => void;
  /** The most recent `terminal_grid` echo, or null if none has arrived yet. */
  getAppliedGrid: () => TerminalGridAck | null;
  requestFrame: (callback: () => void) => number;
  cancelFrame: (handle: number) => void;
  onSettled?: (reason: TerminalGridReconcileReason, grid: TerminalGridDimensions) => void;
};

export type TerminalGridReconcileHandle = { cancel: () => void };

/** Consecutive authoritative frames at one grid before the echo is checked. */
const SETTLE_FRAMES = 8;
/** ~3s at 60fps. Bounds a pane that never becomes visible or never stabilizes. */
const MAX_FRAMES = 180;
/**
 * Resends after the echo disagrees. A disagreement usually means the request
 * was dropped in flight, which a resend fixes; if three do not, the cause is
 * not transient and hammering the PTY will not help.
 */
const MAX_RESENDS = 3;
/** A visible pane pinned at 0x0 renders blank. 80x24 is the terminal default. */
const FALLBACK_GRID: TerminalGridDimensions = { cols: 80, rows: 24 };

function isUsable(
  grid: TerminalGridDimensions | null,
): grid is TerminalGridDimensions {
  return Boolean(grid && grid.cols > 0 && grid.rows > 0);
}

function gridsEqual(
  a: TerminalGridDimensions | null,
  b: TerminalGridDimensions | null,
): boolean {
  return a !== null && b !== null && a.cols === b.cols && a.rows === b.rows;
}

export function reconcileTerminalGrid(
  options: TerminalGridReconcileOptions,
): TerminalGridReconcileHandle {
  let frame = 0;
  let authoritativeStableFrames = 0;
  let resends = 0;
  let lastSent: TerminalGridDimensions = options.initialGrid;
  let pendingFrame: number | null = null;
  let finished = false;

  const settle = (reason: TerminalGridReconcileReason): void => {
    if (finished) return;
    finished = true;
    pendingFrame = null;
    options.onSettled?.(reason, lastSent);
  };

  const tick = (): void => {
    pendingFrame = null;
    if (finished) return;
    if (!options.isAlive()) {
      settle('abandoned');
      return;
    }

    frame += 1;

    const measured = options.measure();
    if (isUsable(measured)) {
      // Forward on a renderer mismatch too, not only on a changed measurement.
      // After a snapshot replay the container's proposal can still equal what
      // was last sent while xterm sits at the snapshot's grid — the exact state
      // that renders a narrow-wrapped pane against a wide TUI. Comparing only
      // against `lastSent` would call that settled.
      const rendererAligned = gridsEqual(options.getRendererGrid(), measured);
      if (!gridsEqual(measured, lastSent) || !rendererAligned) {
        options.forward(measured);
        lastSent = measured;
        authoritativeStableFrames = 0;
        resends = 0;
      } else if (options.isAuthoritative()) {
        authoritativeStableFrames += 1;
      }
    }

    const ack = options.getAppliedGrid();
    if (ack && !ack.accepted) {
      // Another surface drives this PTY. Re-sending would only lose again, and
      // claiming the viewport belongs to an explicit user action, not to a
      // background reconcile.
      settle('not-viewport-owner');
      return;
    }

    const gridStable = authoritativeStableFrames >= SETTLE_FRAMES;
    if (gridStable && gridsEqual(ack, lastSent)) {
      settle('verified');
      return;
    }
    if (gridStable && ack !== null && resends < MAX_RESENDS) {
      // Steady locally, but the PTY reports a different size: the request was
      // dropped somewhere between here and the pty. Send it again.
      resends += 1;
      options.forward(lastSent);
      authoritativeStableFrames = 0;
    }

    if (frame < MAX_FRAMES) {
      pendingFrame = options.requestFrame(tick);
      return;
    }

    // Last resort: a visible pane that never measured leaves the PTY at a grid
    // nothing can read. A default beats a blank pane.
    if (options.isAuthoritative() && !isUsable(lastSent)) {
      options.forward(FALLBACK_GRID);
      lastSent = FALLBACK_GRID;
    }
    settle('exhausted');
  };

  pendingFrame = options.requestFrame(tick);

  return {
    cancel: () => {
      if (finished) return;
      finished = true;
      if (pendingFrame !== null) {
        options.cancelFrame(pendingFrame);
        pendingFrame = null;
      }
    },
  };
}
