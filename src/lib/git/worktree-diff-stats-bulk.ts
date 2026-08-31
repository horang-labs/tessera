import {
  computeAndCache,
  getCachedDiffStats,
  isDiffStatsStale,
  scheduleRecompute,
} from './worktree-diff-stats-cache';
import type { WorktreeDiffStats } from '@/types/worktree-diff-stats';

/**
 * Return cached diff stats for each unique workDir. For any workDir without a
 * cache entry, kick off a background compute so the client receives the update
 * via WebSocket push shortly. A cached-but-stale entry is returned as-is and
 * refreshed in the background, so a list load always re-arms counts that a
 * missed push signal left frozen. Never blocks the caller.
 */
export function getCachedOrScheduleBulk(
  workDirs: Array<string | undefined>,
  userId: string,
): Map<string, WorktreeDiffStats | null> {
  const result = new Map<string, WorktreeDiffStats | null>();
  const scheduled = new Set<string>();

  for (const wd of workDirs) {
    if (!wd) continue;
    if (result.has(wd) || scheduled.has(wd)) continue;

    const cached = getCachedDiffStats(wd);
    if (cached !== undefined) {
      result.set(wd, cached);
      if (isDiffStatsStale(wd)) {
        // Debounced so a burst of list loads collapses into one git invocation.
        scheduleRecompute(wd, userId);
      }
    } else {
      scheduled.add(wd);
      // fire-and-forget — broadcast listener will push to the user when ready
      void computeAndCache(wd, userId);
    }
  }

  return result;
}
