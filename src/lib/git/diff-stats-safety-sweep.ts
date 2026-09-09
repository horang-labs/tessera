/**
 * Periodic backstop that re-arms worktree diff stats for sessions with a live
 * runtime.
 *
 * Why: every existing recompute trigger is push-driven, and all of them can go
 * quiet at the same time — a dead file-watch channel, a PTY session that never
 * emits tool side effects, and no turn boundary to flush. When that happens the
 * badge keeps whatever number it last saw until some unrelated activity
 * happens to touch the same workDir. This sweep bounds that window without
 * touching the push paths.
 */

import { crossEnvironmentFilesystemPathKey } from '@/lib/filesystem/path-equivalence';

export interface DiffStatsSafetySweepDependencies {
  /** Users with a live transport; nobody connected means nobody to broadcast to. */
  getConnectedUserIds(): Iterable<string>;
  /** Sessions backed by a running GUI process or PTY, for one user. */
  getActiveSessionIds(userId: string): Iterable<string>;
  getSessionWorkDir(sessionId: string): string | null;
  /** True when the cached entry is missing or older than the TTL. */
  needsRefresh(workDir: string): boolean;
  recompute(workDir: string, userId: string): void;
}

export interface DiffStatsSafetySweepResult {
  /** workDirs handed to recompute this pass. */
  refreshed: string[];
  /** Distinct workDirs the sweep considered, refreshed or not. */
  inspected: number;
}

/**
 * Run a single sweep pass. Pure apart from the injected dependencies so the
 * scheduling policy can be tested without timers, git, or a live server.
 */
export function runDiffStatsSafetySweep(
  dependencies: DiffStatsSafetySweepDependencies,
): DiffStatsSafetySweepResult {
  const refreshed: string[] = [];
  // First user seen for a workDir wins: a shared worktree only needs one
  // recompute, and the broadcast fans out to every session on that workDir.
  const ownerByWorkDir = new Map<string, { workDir: string; userId: string }>();

  for (const userId of dependencies.getConnectedUserIds()) {
    for (const sessionId of dependencies.getActiveSessionIds(userId)) {
      const workDir = dependencies.getSessionWorkDir(sessionId);
      if (!workDir) continue;
      const key = crossEnvironmentFilesystemPathKey(workDir);
      if (ownerByWorkDir.has(key)) continue;
      ownerByWorkDir.set(key, { workDir, userId });
    }
  }

  for (const { workDir, userId } of ownerByWorkDir.values()) {
    if (!dependencies.needsRefresh(workDir)) continue;
    dependencies.recompute(workDir, userId);
    refreshed.push(workDir);
  }

  return { refreshed, inspected: ownerByWorkDir.size };
}
