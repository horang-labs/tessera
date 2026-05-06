import * as path from 'path';
import { getAgentEnvironment } from '@/lib/cli/spawn-cli';
import { computeWorktreeDiffStats } from './worktree-diff-stats';
import type { WorktreeDiffStats } from '@/types/worktree-diff-stats';

const DEBOUNCE_MS = 300;

type Listener = (
  workDir: string,
  stats: WorktreeDiffStats | null,
  userIds: string[],
  previousStats: WorktreeDiffStats | null | undefined,
) => void;

interface CacheEntry {
  stats: WorktreeDiffStats | null;
  computedAt: number;
}

interface CacheState {
  entries: Map<string, CacheEntry>;
  pendingTimers: Map<string, NodeJS.Timeout>;
  pendingUserIds: Map<string, Set<string>>;
  inFlight: Map<string, Promise<WorktreeDiffStats | null>>;
  listeners: Set<Listener>;
}

const GLOBAL_KEY = Symbol.for('tessera.worktreeDiffStatsCache');
const g = globalThis as unknown as { [GLOBAL_KEY]?: CacheState };

function getState(): CacheState {
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = {
      entries: new Map(),
      pendingTimers: new Map(),
      pendingUserIds: new Map(),
      inFlight: new Map(),
      listeners: new Set(),
    };
  }
  return g[GLOBAL_KEY]!;
}

function normalize(workDir: string): string {
  return getPathModule(workDir).resolve(workDir);
}

export function getCachedDiffStats(workDir: string): WorktreeDiffStats | null | undefined {
  const key = normalize(workDir);
  const entry = getState().entries.get(key);
  return entry ? entry.stats : undefined;
}

export function subscribeDiffStats(listener: Listener): () => void {
  const state = getState();
  state.listeners.add(listener);
  return () => {
    state.listeners.delete(listener);
  };
}

function notifyListeners(
  workDir: string,
  stats: WorktreeDiffStats | null,
  userIds: string[],
  previousStats: WorktreeDiffStats | null | undefined,
): void {
  for (const listener of getState().listeners) {
    try {
      listener(workDir, stats, userIds, previousStats);
    } catch {
      // listener errors must not block others
    }
  }
}

async function runCompute(workDir: string, userIds: string[]): Promise<WorktreeDiffStats | null> {
  const state = getState();
  const existing = state.inFlight.get(workDir);
  if (existing) {
    // If another compute is mid-flight, still attach userIds for the listener
    // once it settles — but the simplest contract is: return the same promise
    // and rely on the listener of the in-flight compute to reach those users.
    // For most cases this is fine because connected users get broadcasts via
    // a single listener.
    return existing;
  }

  const promise = (async () => {
    try {
      const agentEnvironment = userIds[0] ? await getAgentEnvironment(userIds[0]) : undefined;
      const stats = await computeWorktreeDiffStats(workDir, agentEnvironment);
      const previousStats = state.entries.get(workDir)?.stats;
      state.entries.set(workDir, { stats, computedAt: Date.now() });
      notifyListeners(workDir, stats, userIds, previousStats);
      return stats;
    } finally {
      state.inFlight.delete(workDir);
    }
  })();

  state.inFlight.set(workDir, promise);
  return promise;
}

/**
 * Trailing-edge debounced recompute. Multiple calls within the debounce window
 * collapse into a single git invocation. The optional userId is accumulated in
 * a set so the resulting broadcast can reach everyone who triggered it.
 */
export function scheduleRecompute(workDir: string, userId?: string): void {
  const key = normalize(workDir);
  const state = getState();

  if (userId) {
    let set = state.pendingUserIds.get(key);
    if (!set) {
      set = new Set();
      state.pendingUserIds.set(key, set);
    }
    set.add(userId);
  }

  const existing = state.pendingTimers.get(key);
  if (existing) clearTimeout(existing);

  const timer = setTimeout(() => {
    state.pendingTimers.delete(key);
    const userIds = Array.from(state.pendingUserIds.get(key) ?? []);
    state.pendingUserIds.delete(key);
    void runCompute(key, userIds);
  }, DEBOUNCE_MS);
  state.pendingTimers.set(key, timer);
}

/**
 * Flush any pending debounce for the given workDir and compute immediately.
 * Used at turn-end so the final state reaches the client without waiting.
 */
export function flushRecompute(workDir: string, userId?: string): Promise<WorktreeDiffStats | null> {
  const key = normalize(workDir);
  const state = getState();
  const timer = state.pendingTimers.get(key);
  if (timer) {
    clearTimeout(timer);
    state.pendingTimers.delete(key);
  }
  const accumulated = state.pendingUserIds.get(key);
  state.pendingUserIds.delete(key);
  const userIds = accumulated ? Array.from(accumulated) : [];
  if (userId && !userIds.includes(userId)) userIds.push(userId);
  return runCompute(key, userIds);
}

function getPathModule(filesystemPath: string): typeof path.win32 | typeof path.posix {
  return isWindowsStylePath(filesystemPath) ? path.win32 : path.posix;
}

function isWindowsStylePath(filesystemPath: string): boolean {
  return (
    /^[a-zA-Z]:[\\/]/.test(filesystemPath)
    || /^[a-zA-Z]:$/.test(filesystemPath)
    || filesystemPath.startsWith('\\\\')
    || filesystemPath.startsWith('//')
  );
}

/**
 * Compute now and broadcast to the caller's user. Safe to call from list
 * endpoints for cache-miss workDirs. Uses the shared in-flight map so parallel
 * callers for the same workDir coalesce.
 */
export async function computeAndCache(
  workDir: string,
  userId: string,
): Promise<WorktreeDiffStats | null> {
  return runCompute(normalize(workDir), [userId]);
}
