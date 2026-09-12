import { invalidateGitPanelReads, gitReadKey, getGitReadGeneration, normalizeGitReadPath } from './git-read-cache';
import { resolveGitEnvironment } from '@/lib/git/git-environment';
import {
  isWindowsHostedWslFilesystemPath,
} from '@/lib/filesystem/path-environment';
import { computeWorktreeDiffStats } from './worktree-diff-stats';
import { isDiffStatsEntryStale } from './worktree-diff-stats-staleness';
import type { WorktreeDiffStats } from '@/types/worktree-diff-stats';

const DEBOUNCE_MS = 300;
// One worktree at a time. A worktree compute may cross the Windows/WSL process
// boundary; completing wsl.exe does not mean its conhost teardown has drained.
// Keeping two worktrees active allowed the next wave to outrun that teardown.
const MAX_CONCURRENT_COMPUTES = 1;

type Listener = (
  workDir: string,
  stats: WorktreeDiffStats | null,
  userIds: string[],
  previousStats: WorktreeDiffStats | null | undefined,
) => void;

interface CacheEntry {
  stats: WorktreeDiffStats | null;
  computedAt: number;
  generation: number;
}

interface CacheState {
  entries: Map<string, CacheEntry>;
  readKeys: Map<string, string>;
  pendingTimers: Map<string, NodeJS.Timeout>;
  pendingUserIds: Map<string, Set<string>>;
  pendingBroadcastWorkDirs: Map<string, string>;
  rerunUserIds: Map<string, Set<string>>;
  rerunBroadcastWorkDirs: Map<string, string>;
  inFlight: Map<string, Promise<WorktreeDiffStats | null>>;
  activeComputeCount: number;
  queuedComputes: Array<() => Promise<void>>;
  listeners: Set<Listener>;
}

const GLOBAL_KEY = Symbol.for('tessera.worktreeDiffStatsCache');
const g = globalThis as unknown as { [GLOBAL_KEY]?: CacheState };

function getState(): CacheState {
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = {
      entries: new Map(),
      readKeys: new Map(),
      pendingTimers: new Map(),
      pendingUserIds: new Map(),
      pendingBroadcastWorkDirs: new Map(),
      rerunUserIds: new Map(),
      rerunBroadcastWorkDirs: new Map(),
      inFlight: new Map(),
      activeComputeCount: 0,
      queuedComputes: [],
      listeners: new Set(),
    };
  }
  const state = g[GLOBAL_KEY]!;
  // Keep Next.js hot-reload state created by an older module shape usable.
  state.readKeys ??= new Map();
  state.rerunUserIds ??= new Map();
  state.pendingBroadcastWorkDirs ??= new Map();
  state.rerunBroadcastWorkDirs ??= new Map();
  state.activeComputeCount ??= 0;
  state.queuedComputes ??= [];
  return state;
}

function drainComputeQueue(): void {
  const state = getState();
  while (
    state.activeComputeCount < MAX_CONCURRENT_COMPUTES
    && state.queuedComputes.length > 0
  ) {
    const compute = state.queuedComputes.shift()!;
    state.activeComputeCount += 1;
    void compute().finally(() => {
      state.activeComputeCount -= 1;
      drainComputeQueue();
    });
  }
}

function runWithComputeLimit<T>(compute: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    getState().queuedComputes.push(async () => {
      try {
        resolve(await compute());
      } catch (error) {
        reject(error);
      }
    });
    drainComputeQueue();
  });
}

export function normalizeWorktreeDiffStatsCacheKey(workDir: string): string {
  return normalizeGitReadPath(workDir);
}

function scopeKey(workDir: string, userId?: string): string {
  return JSON.stringify([normalizeWorktreeDiffStatsCacheKey(workDir), userId ?? null]);
}

function cachedEntry(workDir: string, userId?: string): CacheEntry | undefined {
  const state = getState();
  const key = state.readKeys.get(scopeKey(workDir, userId));
  const entry = key ? state.entries.get(key) : undefined;
  return entry?.generation === getGitReadGeneration() ? entry : undefined;
}

export function getCachedDiffStats(workDir: string, userId?: string): WorktreeDiffStats | null | undefined {
  return cachedEntry(workDir, userId)?.stats;
}

/**
 * True when a cache entry exists but is older than the TTL. A cache miss is
 * NOT stale — callers distinguish the two because a miss needs a blocking-free
 * first compute while a stale hit still has a usable value to return meanwhile.
 */
export function isDiffStatsStale(workDir: string, now: number = Date.now(), userId?: string): boolean {
  const entry = cachedEntry(workDir, userId);
  if (!entry) return false;
  return isDiffStatsEntryStale(entry.computedAt, now);
}

/**
 * Cached value for a read path, refreshing it in the background when the entry
 * has gone stale. The returned value is whatever is cached right now (possibly
 * stale); the refresh reaches the client via the diff-stats broadcast.
 */
export function getCachedDiffStatsRevalidating(
  workDir: string,
  userId: string,
): WorktreeDiffStats | null | undefined {
  const cached = getCachedDiffStats(workDir, userId);
  if (cached !== undefined && isDiffStatsStale(workDir, Date.now(), userId)) {
    scheduleRecompute(workDir, userId);
  }
  return cached;
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

export function preferWorktreeDiffStatsBroadcastPath(
  current: string | undefined,
  candidate: string,
): string {
  if (isWindowsHostedWslFilesystemPath(candidate)) return candidate;
  return current ?? candidate;
}

async function runCompute(
  workDir: string,
  userIds: string[],
  broadcastWorkDir: string,
  refresh = true,
): Promise<WorktreeDiffStats | null> {
  const userId = userIds[0];
  const agentEnvironment = await resolveGitEnvironment(
    userId ? { userId } : { inferFromPaths: [workDir] },
  );
  const key = gitReadKey(workDir, agentEnvironment, userId, 'diff-stats', [getGitReadGeneration()]);
  const state = getState();
  if (state.readKeys.size >= 256 && !state.readKeys.has(scopeKey(workDir, userId))) {
    state.readKeys.delete(state.readKeys.keys().next().value!);
  }
  state.readKeys.set(scopeKey(workDir, userId), key);
  const existing = state.inFlight.get(key);
  if (existing) {
    if (!refresh) return existing;
    let queuedUserIds = state.rerunUserIds.get(key);
    if (!queuedUserIds) {
      queuedUserIds = new Set();
      state.rerunUserIds.set(key, queuedUserIds);
    }
    for (const userId of userIds) queuedUserIds.add(userId);
    state.rerunBroadcastWorkDirs.set(
      key,
      preferWorktreeDiffStatsBroadcastPath(
        state.rerunBroadcastWorkDirs.get(key),
        broadcastWorkDir,
      ),
    );
    return existing;
  }

  const promise = (async () => {
    try {
      let nextUserIds = userIds;
      let nextBroadcastWorkDir = broadcastWorkDir;
      let stats: WorktreeDiffStats | null = null;

      // A filesystem event or Stop flush can arrive while git is still being
      // queried. Keep one shared promise, but repeat the query until no newer
      // request remains so the final broadcast cannot expose stale counts.
      while (true) {
        const generation = getGitReadGeneration();
        stats = await runWithComputeLimit(() => computeWorktreeDiffStats(workDir, agentEnvironment));
        const previousStats = state.entries.get(key)?.stats;
        // A refresh or mutation during this read invalidates its result.
        if (generation === getGitReadGeneration() && !state.rerunUserIds.has(key)) {
          if (state.entries.size >= 256 && !state.entries.has(key)) {
            state.entries.delete(state.entries.keys().next().value!);
          }
          state.entries.set(key, { stats, computedAt: Date.now(), generation });
        }
        if (generation === getGitReadGeneration() && !state.rerunUserIds.has(key)) {
          notifyListeners(nextBroadcastWorkDir, stats, nextUserIds, previousStats);
        }

        const queuedUserIds = state.rerunUserIds.get(key);
        if (!queuedUserIds) return stats;
        state.rerunUserIds.delete(key);
        nextUserIds = Array.from(queuedUserIds);
        nextBroadcastWorkDir = state.rerunBroadcastWorkDirs.get(key)
          ?? nextBroadcastWorkDir;
        state.rerunBroadcastWorkDirs.delete(key);
      }
    } finally {
      state.rerunUserIds.delete(key);
      state.rerunBroadcastWorkDirs.delete(key);
      state.inFlight.delete(key);
    }
  })();

  state.inFlight.set(key, promise);
  return promise;
}

/**
 * Trailing-edge debounced recompute. Multiple calls within the debounce window
 * collapse into a single git invocation. The optional userId is accumulated in
 * a set so the resulting broadcast can reach everyone who triggered it.
 */
export function scheduleRecompute(workDir: string, userId?: string): void {
  invalidateGitPanelReads();
  const key = scopeKey(workDir, userId);
  const state = getState();

  if (userId) {
    let set = state.pendingUserIds.get(key);
    if (!set) {
      set = new Set();
      state.pendingUserIds.set(key, set);
    }
    set.add(userId);
  }
  state.pendingBroadcastWorkDirs.set(
    key,
    preferWorktreeDiffStatsBroadcastPath(
      state.pendingBroadcastWorkDirs.get(key),
      workDir,
    ),
  );

  const existing = state.pendingTimers.get(key);
  if (existing) clearTimeout(existing);

  const timer = setTimeout(() => {
    state.pendingTimers.delete(key);
    const userIds = Array.from(state.pendingUserIds.get(key) ?? []);
    state.pendingUserIds.delete(key);
    const broadcastWorkDir = state.pendingBroadcastWorkDirs.get(key) ?? workDir;
    state.pendingBroadcastWorkDirs.delete(key);
    void runCompute(workDir, userIds, broadcastWorkDir).catch(() => {
      // A rejected environment lookup must not become an unhandled timer rejection.
    });
  }, DEBOUNCE_MS);
  state.pendingTimers.set(key, timer);
}

/**
 * Flush any pending debounce for the given workDir and compute immediately.
 * Used at turn-end so the final state reaches the client without waiting.
 */
export function flushRecompute(workDir: string, userId?: string): Promise<WorktreeDiffStats | null> {
  invalidateGitPanelReads();
  const key = scopeKey(workDir, userId);
  const state = getState();
  const timer = state.pendingTimers.get(key);
  if (timer) {
    clearTimeout(timer);
    state.pendingTimers.delete(key);
  }
  const accumulated = state.pendingUserIds.get(key);
  state.pendingUserIds.delete(key);
  const pendingBroadcastWorkDir = state.pendingBroadcastWorkDirs.get(key);
  state.pendingBroadcastWorkDirs.delete(key);
  const userIds = accumulated ? Array.from(accumulated) : [];
  if (userId && !userIds.includes(userId)) userIds.push(userId);
  return runCompute(
    workDir,
    userIds,
    preferWorktreeDiffStatsBroadcastPath(pendingBroadcastWorkDir, workDir),
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
  return runCompute(workDir, [userId], workDir, false);
}
