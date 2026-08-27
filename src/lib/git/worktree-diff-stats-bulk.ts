import {
  getCachedDiffStats,
  isDiffStatsStale,
  scheduleRecompute,
} from './worktree-diff-stats-cache';
import type { WorktreeDiffStats } from '@/types/worktree-diff-stats';
import { crossEnvironmentFilesystemPathKey } from '@/lib/filesystem/path-equivalence';

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
 * Read cached stats for each unique checkout without creating background work.
 * Cold, cross-project list endpoints use this so opening Tessera cannot turn
 * every persisted row into a Git/WSL job.
 */
export function getCachedBulk(
  workDirs: Array<string | undefined>,
  readCached: typeof getCachedDiffStats = getCachedDiffStats,
): Map<string, WorktreeDiffStats | null> {
  const result = new Map<string, WorktreeDiffStats | null>();
  const visited = new Set<string>();

  for (const workDir of workDirs) {
    if (!workDir) continue;
    const key = crossEnvironmentFilesystemPathKey(workDir);
    if (visited.has(key)) continue;
    visited.add(key);
    const cached = readCached(workDir);
    if (cached !== undefined) result.set(workDir, cached);
  }

  return result;
}

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
    const key = crossEnvironmentFilesystemPathKey(wd);
    if (visited.has(key)) continue;
    visited.add(key);

    const cached = dependencies.readCached(wd);
    if (cached !== undefined) {
      result.set(wd, cached);
      if (!dependencies.isStale(wd)) continue;
    }
    dependencies.schedule(wd, userId);
  }

  return result;
}
