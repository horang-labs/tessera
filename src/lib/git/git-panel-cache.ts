import logger from '@/lib/logger';
import { getGitPanelData, type GitPanelSnapshot } from './git-panel';
import { GitReadCache, gitReadKey, invalidateGitPanelReads } from './git-read-cache';
import type { AgentEnvironment } from '@/lib/settings/types';
import type { GitPanelData, GitDiffData } from '@/types/git';

// Only repository data is shared. Session/task/PR metadata is assembled per caller.

export function readGitPanelSnapshot(
  workDir: string,
  environment: AgentEnvironment,
  userId: string | undefined,
  compute: () => Promise<GitPanelSnapshot>,
): Promise<GitPanelSnapshot> {
  return getState().snapshotReads.read(gitReadKey(workDir, environment, userId, 'panel-snapshot'), compute);
}

export function readGitDiff(
  workDir: string,
  environment: AgentEnvironment,
  userId: string | undefined,
  relativePath: string,
  compute: () => Promise<GitDiffData>,
): Promise<GitDiffData> {
  return getState().diffReads.read(gitReadKey(workDir, environment, userId, 'file-diff', [relativePath]), compute);
}

const DEBOUNCE_MS = 300;

type Listener = (
  sessionId: string,
  data: GitPanelData | null,
  userIds: string[],
) => void;

interface CacheState {
  snapshotReads: GitReadCache<GitPanelSnapshot>;
  diffReads: GitReadCache<GitDiffData>;
  broadcasts: Map<string, object>;
  pendingTimers: Map<string, NodeJS.Timeout>;
  pendingUserIds: Map<string, Set<string>>;
  listeners: Set<Listener>;
}

const GLOBAL_KEY = Symbol.for('tessera.gitPanelCache');
const g = globalThis as unknown as { [GLOBAL_KEY]?: CacheState };

function getState(): CacheState {
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = {
      snapshotReads: new GitReadCache<GitPanelSnapshot>(250),
      diffReads: new GitReadCache<GitDiffData>(250),
      broadcasts: new Map(),
      pendingTimers: new Map(),
      pendingUserIds: new Map(),
      listeners: new Set(),
    };
  }
  const state = g[GLOBAL_KEY]!;
  state.snapshotReads ??= new GitReadCache<GitPanelSnapshot>(250);
  state.diffReads ??= new GitReadCache<GitDiffData>(250);
  state.broadcasts ??= new Map();
  return state;
}

export function subscribeGitPanelData(listener: Listener): () => void {
  const state = getState();
  state.listeners.add(listener);
  return () => {
    state.listeners.delete(listener);
  };
}

function notifyListeners(
  sessionId: string,
  data: GitPanelData | null,
  userIds: string[],
): void {
  for (const listener of getState().listeners) {
    try {
      listener(sessionId, data, userIds);
    } catch {
      // listener errors must not block others
    }
  }
}

async function runCompute(
  sessionId: string,
  userIds: string[],
): Promise<GitPanelData | null> {
  // Users may select different Git environments. Never broadcast the first
  // user's snapshot to everyone who happened to trigger the debounce window.
  const results = await Promise.all((userIds.length ? userIds : [undefined]).map(async (userId) => {
    const key = JSON.stringify([sessionId, userId]);
    const token = {};
    const broadcasts = getState().broadcasts;
    broadcasts.set(key, token);
    let data: GitPanelData | null = null;
    try {
      data = await getGitPanelData(sessionId, userId);
    } catch (error) {
      logger.debug({ error, sessionId }, 'getGitPanelData failed in recompute');
    }
    if (broadcasts.get(key) === token) {
      broadcasts.delete(key);
      notifyListeners(sessionId, data, userId ? [userId] : []);
    }
    return data;
  }));
  return results[0] ?? null;
}

/**
 * Trailing-edge debounced recompute keyed by sessionId. Multiple calls inside
 * the debounce window collapse into a single getGitPanelData invocation. Any
 * userIds that triggered the window are accumulated so the resulting broadcast
 * reaches everyone who caused it.
 */
export function scheduleGitPanelRecompute(
  sessionId: string,
  userId?: string,
): void {
  invalidateGitPanelReads();
  const state = getState();

  if (userId) {
    let set = state.pendingUserIds.get(sessionId);
    if (!set) {
      set = new Set();
      state.pendingUserIds.set(sessionId, set);
    }
    set.add(userId);
  }

  const existing = state.pendingTimers.get(sessionId);
  if (existing) clearTimeout(existing);

  const timer = setTimeout(() => {
    state.pendingTimers.delete(sessionId);
    const userIds = Array.from(state.pendingUserIds.get(sessionId) ?? []);
    state.pendingUserIds.delete(sessionId);
    void runCompute(sessionId, userIds);
  }, DEBOUNCE_MS);
  state.pendingTimers.set(sessionId, timer);
}

/**
 * Flush any pending debounce for the given sessionId and recompute now. Used
 * at turn-end and after sync operations so the final state reaches the client
 * without waiting for the debounce window.
 */
export function flushGitPanelRecompute(
  sessionId: string,
  userId?: string,
  options: { invalidate?: boolean } = {},
): Promise<GitPanelData | null> {
  if (options.invalidate !== false) invalidateGitPanelReads();
  const state = getState();
  const timer = state.pendingTimers.get(sessionId);
  if (timer) {
    clearTimeout(timer);
    state.pendingTimers.delete(sessionId);
  }
  const accumulated = state.pendingUserIds.get(sessionId);
  state.pendingUserIds.delete(sessionId);
  const userIds = accumulated ? Array.from(accumulated) : [];
  if (userId && !userIds.includes(userId)) userIds.push(userId);
  return runCompute(sessionId, userIds);
}
