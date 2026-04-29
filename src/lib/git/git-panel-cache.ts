import logger from '@/lib/logger';
import { getGitPanelData } from './git-panel';
import type { GitPanelData } from '@/types/git';

const DEBOUNCE_MS = 300;

type Listener = (
  sessionId: string,
  data: GitPanelData | null,
  userIds: string[],
) => void;

interface CacheState {
  pendingTimers: Map<string, NodeJS.Timeout>;
  pendingUserIds: Map<string, Set<string>>;
  inFlight: Map<string, Promise<GitPanelData | null>>;
  listeners: Set<Listener>;
}

const GLOBAL_KEY = Symbol.for('tessera.gitPanelCache');
const g = globalThis as unknown as { [GLOBAL_KEY]?: CacheState };

function getState(): CacheState {
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = {
      pendingTimers: new Map(),
      pendingUserIds: new Map(),
      inFlight: new Map(),
      listeners: new Set(),
    };
  }
  return g[GLOBAL_KEY]!;
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
  const state = getState();
  const existing = state.inFlight.get(sessionId);
  if (existing) return existing;

  const promise = (async () => {
    try {
      let data: GitPanelData | null = null;
      try {
        data = await getGitPanelData(sessionId);
      } catch (error) {
        // Sessions without a work_dir, non-git directories, etc. all throw
        // GitPanelError. Treat as "nothing to broadcast" — the live UI keeps
        // whatever it already had.
        logger.debug({ error, sessionId }, 'getGitPanelData failed in recompute');
        data = null;
      }
      notifyListeners(sessionId, data, userIds);
      return data;
    } finally {
      state.inFlight.delete(sessionId);
    }
  })();

  state.inFlight.set(sessionId, promise);
  return promise;
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
): Promise<GitPanelData | null> {
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
