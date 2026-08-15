import logger from '@/lib/logger';
import { getActiveSessionIds } from '@/lib/session/active-session-runtime';
import { getManagedSessionWorkDir } from './session-diff-refresh';
import {
  getCachedDiffStats,
  isDiffStatsStale,
  scheduleRecompute,
} from './worktree-diff-stats-cache';
import {
  runDiffStatsSafetySweep,
  type DiffStatsSafetySweepDependencies,
} from './diff-stats-safety-sweep';

/**
 * Sweep cadence. Matches the interval Orca uses for its equivalent git status
 * safety refresh: frequent enough that a wrong badge is short-lived, slow
 * enough that it costs one debounced git pass per active worktree at most.
 */
const SWEEP_INTERVAL_MS = 60_000;

interface SweepState {
  timer: NodeJS.Timeout | null;
}

// globalThis so Next.js hot reload cannot leave a second timer running.
const SWEEP_KEY = Symbol.for('tessera.diffStatsSafetySweep');
const g = globalThis as unknown as { [SWEEP_KEY]?: SweepState };

function getState(): SweepState {
  if (!g[SWEEP_KEY]) g[SWEEP_KEY] = { timer: null };
  return g[SWEEP_KEY]!;
}

function buildDependencies(
  getConnectedUserIds: () => Iterable<string>,
): DiffStatsSafetySweepDependencies {
  return {
    getConnectedUserIds,
    getActiveSessionIds: (userId) => getActiveSessionIds(userId),
    getSessionWorkDir: (sessionId) => getManagedSessionWorkDir(sessionId),
    needsRefresh: (workDir) =>
      getCachedDiffStats(workDir) === undefined || isDiffStatsStale(workDir),
    recompute: (workDir, userId) => scheduleRecompute(workDir, userId),
  };
}

/**
 * Start the periodic sweep. Idempotent — a second call is a no-op while a
 * timer is already armed.
 */
export function installDiffStatsSafetySweep(
  getConnectedUserIds: () => Iterable<string>,
): void {
  const state = getState();
  if (state.timer) return;

  const dependencies = buildDependencies(getConnectedUserIds);
  state.timer = setInterval(() => {
    try {
      const { refreshed, inspected } = runDiffStatsSafetySweep(dependencies);
      if (refreshed.length > 0) {
        logger.debug({ refreshed, inspected }, 'Diff stats safety sweep re-armed stale worktrees');
      }
    } catch (error) {
      logger.warn({ error }, 'Diff stats safety sweep failed');
    }
  }, SWEEP_INTERVAL_MS);
  // Never hold the process open for a backstop.
  state.timer.unref?.();
}

export function uninstallDiffStatsSafetySweep(): void {
  const state = getState();
  if (!state.timer) return;
  clearInterval(state.timer);
  state.timer = null;
}
