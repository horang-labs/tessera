/**
 * Progress curve for the docked compacting bar.
 *
 * No provider reports how far a compaction has got: the stream goes completely
 * silent between the frame that opens the phase and the one that closes it
 * (measured at ~13s of silence for a 28k-token compaction). The Claude Code TUI
 * has the same problem and solves it with a bar that is a pure function of
 * elapsed time — an exponential ease-out with a 90s time constant, capped at 95%
 * so it never claims to be done. We reuse that curve verbatim so the web UI and
 * the terminal show the same number at the same moment.
 */

export const COMPACT_PROGRESS_TIME_CONSTANT_MS = 90_000;
export const COMPACT_PROGRESS_MAX_PERCENT = 95;

/** How often the bar re-renders while a compaction is running. */
export const COMPACT_PROGRESS_TICK_MS = 250;

/**
 * Give up on a bar that was never closed — a provider that dies mid-compaction,
 * or a Codex compaction the CLI silently refused, would otherwise pin it open.
 */
export const COMPACT_PROGRESS_STALE_AFTER_MS = 10 * 60_000;

export function computeCompactProgressPercent(elapsedMs: number): number {
  const elapsed = Math.max(0, elapsedMs);
  const ratio = 1 - Math.exp(-elapsed / COMPACT_PROGRESS_TIME_CONSTANT_MS);
  return Math.min(COMPACT_PROGRESS_MAX_PERCENT, Math.round(ratio * 100));
}
