import { getCachedDiffStats } from './worktree-diff-stats-cache';
import type { WorktreeDiffStats } from '@/types/worktree-diff-stats';

/**
 * Return cached diff stats for each unique workDir without causing filesystem
 * or Git work. Project/session/task list endpoints call this during cold start
 * with every row they loaded; treating a cache miss as an eager compute turns
 * historical data into an unbounded process-spawn queue on Windows + WSL.
 *
 * Active runtimes, workspace invalidations, turn completion and an explicitly
 * opened Git panel own recomputation. A passive list read must stay passive.
 */
export function getCachedBulk(
  workDirs: Array<string | undefined>,
  readCached: typeof getCachedDiffStats = getCachedDiffStats,
): Map<string, WorktreeDiffStats | null> {
  const result = new Map<string, WorktreeDiffStats | null>();

  for (const wd of workDirs) {
    if (!wd) continue;
    if (result.has(wd)) continue;

    const cached = readCached(wd);
    if (cached !== undefined) {
      result.set(wd, cached);
    }
  }

  return result;
}
