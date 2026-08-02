/**
 * Age policy for cached worktree diff stats.
 *
 * Kept free of imports so the policy can be exercised without pulling in the
 * cache's git/settings dependency chain.
 */

/**
 * Age past which a cached entry is no longer trusted on read.
 *
 * Why: recompute is purely push-driven (file watch, per-tool side effect,
 * turn-end flush). Every one of those can go silent at once — a dead WSL
 * inotify bridge plus PTY-only sessions plus no turn boundary pinned real
 * counts for two hours in practice. This TTL is the sole backstop that bounds
 * how long a missed signal can keep wrong numbers on screen.
 */
export const DIFF_STATS_STALE_TTL_MS = 2 * 60_000;

/** True once an entry computed at `computedAt` has reached the TTL. */
export function isDiffStatsEntryStale(computedAt: number, now: number): boolean {
  return now - computedAt >= DIFF_STATS_STALE_TTL_MS;
}
