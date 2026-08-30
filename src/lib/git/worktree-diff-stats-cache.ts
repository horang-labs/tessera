import * as path from 'path';
import { resolveGitEnvironment } from '@/lib/git/git-environment';
import {
  formatWindowsHostedWslDisplayPath,
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
}

interface CacheState {
  entries: Map<string, CacheEntry>;
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
  const trimmed = workDir.trim();
  // The DB can contain both a CLI-reported `/home/...` path and the Windows
  // server's `\\wsl.localhost\<distro>\home\...` spelling for the same tree.
  // Collapse those spellings before cache/in-flight lookup so one invalidation
  // cannot create two WSL probes. Windows-native drive paths stay untouched.
  if (isWindowsHostedWslFilesystemPath(trimmed)) {
    return path.posix.resolve(formatWindowsHostedWslDisplayPath(trimmed, null));
  }
  return getPathModule(trimmed).resolve(trimmed);
}

export function getCachedDiffStats(workDir: string): WorktreeDiffStats | null | undefined {
  const key = normalizeWorktreeDiffStatsCacheKey(workDir);
  const entry = getState().entries.get(key);
  return entry ? entry.stats : undefined;
}

/**
 * True when a cache entry exists but is older than the TTL. A cache miss is
 * NOT stale — callers distinguish the two because a miss needs a blocking-free
 * first compute while a stale hit still has a usable value to return meanwhile.
 */
export function isDiffStatsStale(workDir: string, now: number = Date.now()): boolean {
  const entry = getState().entries.get(normalizeWorktreeDiffStatsCacheKey(workDir));
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
  const cached = getCachedDiffStats(workDir);
  if (cached !== undefined && isDiffStatsStale(workDir)) {
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
): Promise<WorktreeDiffStats | null> {
  const state = getState();
  const existing = state.inFlight.get(workDir);
  if (existing) {
    let queuedUserIds = state.rerunUserIds.get(workDir);
    if (!queuedUserIds) {
      queuedUserIds = new Set();
      state.rerunUserIds.set(workDir, queuedUserIds);
    }
    for (const userId of userIds) queuedUserIds.add(userId);
    state.rerunBroadcastWorkDirs.set(
      workDir,
      preferWorktreeDiffStatsBroadcastPath(
        state.rerunBroadcastWorkDirs.get(workDir),
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
        stats = await runWithComputeLimit(async () => {
          // A recompute can be triggered by a filesystem event with no user
          // attached, so the fallback to the worktree path is named here.
          const agentEnvironment = await resolveGitEnvironment(
            nextUserIds[0]
              ? { userId: nextUserIds[0] }
              : { inferFromPaths: [workDir] },
          );
          return computeWorktreeDiffStats(workDir, agentEnvironment);
        });
        const previousStats = state.entries.get(workDir)?.stats;
        state.entries.set(workDir, { stats, computedAt: Date.now() });
        notifyListeners(nextBroadcastWorkDir, stats, nextUserIds, previousStats);

        const queuedUserIds = state.rerunUserIds.get(workDir);
        if (!queuedUserIds) return stats;
        state.rerunUserIds.delete(workDir);
        nextUserIds = Array.from(queuedUserIds);
        nextBroadcastWorkDir = state.rerunBroadcastWorkDirs.get(workDir)
          ?? nextBroadcastWorkDir;
        state.rerunBroadcastWorkDirs.delete(workDir);
      }
    } finally {
      state.rerunUserIds.delete(workDir);
      state.rerunBroadcastWorkDirs.delete(workDir);
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
  const key = normalizeWorktreeDiffStatsCacheKey(workDir);
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
    void runCompute(key, userIds, broadcastWorkDir);
  }, DEBOUNCE_MS);
  state.pendingTimers.set(key, timer);
}

/**
 * Flush any pending debounce for the given workDir and compute immediately.
 * Used at turn-end so the final state reaches the client without waiting.
 */
export function flushRecompute(workDir: string, userId?: string): Promise<WorktreeDiffStats | null> {
  const key = normalizeWorktreeDiffStatsCacheKey(workDir);
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
    key,
    userIds,
    preferWorktreeDiffStatsBroadcastPath(pendingBroadcastWorkDir, workDir),
  );
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
  return runCompute(normalizeWorktreeDiffStatsCacheKey(workDir), [userId], workDir);
}
