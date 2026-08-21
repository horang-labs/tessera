import {
  getCachedDiffStats,
  isDiffStatsStale,
  scheduleRecompute,
} from './worktree-diff-stats-cache';
import type { WorktreeDiffStats } from '@/types/worktree-diff-stats';

interface BulkDiffStatsDependencies {
  readCached: typeof getCachedDiffStats;
  isStale: typeof isDiffStatsStale;
  schedule: typeof scheduleRecompute;
}

const defaultDependencies: BulkDiffStatsDependencies = {
  readCached: getCachedDiffStats,
  isStale: isDiffStatsStale,
  schedule: scheduleRecompute,
};

/**
 * Return cached diff stats immediately, then enqueue every unique missing or
 * stale workDir in list order. The shared cache owns debounce/deduplication and
 * runs at most one Git computation at a time, so sidebar badges fill in
 * progressively without list requests blocking on Windows + WSL process work.
 */
export function getCachedOrScheduleBulk(
  workDirs: Array<string | undefined>,
  userId: string,
  dependencies: BulkDiffStatsDependencies = defaultDependencies,
): Map<string, WorktreeDiffStats | null> {
  const result = new Map<string, WorktreeDiffStats | null>();
  const visited = new Set<string>();

  for (const wd of workDirs) {
    if (!wd) continue;
    if (visited.has(wd)) continue;
    visited.add(wd);

    const cached = dependencies.readCached(wd);
    if (cached !== undefined) {
      result.set(wd, cached);
      if (!dependencies.isStale(wd)) continue;
    }
    dependencies.schedule(wd, userId);
  }

  return result;
}
