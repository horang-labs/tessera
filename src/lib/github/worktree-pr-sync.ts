/** PR detection for a canonical Worktree selected without a Session. */
import * as dbWorktrees from '@/lib/db/worktrees';
import { resolveGitEnvironment } from '@/lib/git/git-environment';
import logger from '@/lib/logger';
import type { AgentEnvironment } from '@/lib/settings/types';
import type { TaskPrStatus } from '@/types/task-pr-status';
import { probeTaskPrStatus, resolveCurrentBranch } from './pr-status-provider';

export interface WorktreePrCacheEntry {
  branch: string | null;
  agentEnvironment: AgentEnvironment;
  prStatus?: TaskPrStatus;
  prStatusKnown: boolean;
  prUnsupported: boolean;
  remoteBranchExists?: boolean;
  lastSyncedAt: number;
}

const GLOBAL_KEY = Symbol.for('tessera.worktreePrSync');
const WORKTREE_PR_CACHE_TTL_MS = 60_000;
interface SyncState {
  cache: Map<string, WorktreePrCacheEntry>;
  inFlight: Map<string, Promise<void>>;
}
const globalState = globalThis as unknown as { [GLOBAL_KEY]?: SyncState };

function getState(): SyncState {
  if (!globalState[GLOBAL_KEY]) {
    globalState[GLOBAL_KEY] = { cache: new Map(), inFlight: new Map() };
  }
  return globalState[GLOBAL_KEY]!;
}

export function getCachedWorktreePr(
  worktreeId: string,
  options: {
    userId?: string;
    branch: string | null;
    agentEnvironment: AgentEnvironment;
  },
): WorktreePrCacheEntry | undefined {
  const cached = getState().cache.get(cacheKey(worktreeId, options.userId));
  return cached?.branch === options.branch
    && cached.agentEnvironment === options.agentEnvironment
    ? cached
    : undefined;
}

function cacheKey(worktreeId: string, userId?: string): string {
  return `${userId ?? 'inferred'}\0${worktreeId}`;
}

function apply(
  key: string,
  next: Omit<WorktreePrCacheEntry, 'lastSyncedAt'>,
): void {
  getState().cache.set(key, { ...next, lastSyncedAt: Date.now() });
}

export function syncWorktreePr(
  worktreeId: string,
  options: {
    agentEnvironment?: AgentEnvironment;
    userId?: string;
    force?: boolean;
    branch?: string | null;
  } = {},
): Promise<void> {
  const state = getState();
  const key = cacheKey(worktreeId, options.userId);
  const existing = state.inFlight.get(key);
  if (existing) return existing;

  const promise = (async () => {
    try {
      const worktree = dbWorktrees.getWorktree(worktreeId);
      if (!worktree?.filesystemPath) return;
      const agentEnvironment = options.agentEnvironment
        ?? await resolveGitEnvironment(
          options.userId
            ? { userId: options.userId }
            : { inferFromPaths: [worktree.filesystemPath] },
        );
      const branch = options.branch === undefined
        ? await resolveCurrentBranch(worktree.filesystemPath, agentEnvironment)
        : options.branch;
      const cached = state.cache.get(key);
      if (
        !options.force
        && cached?.branch === branch
        && cached.agentEnvironment === agentEnvironment
        && Date.now() - cached.lastSyncedAt < WORKTREE_PR_CACHE_TTL_MS
      ) return;
      if (!branch) {
        apply(key, {
          branch,
          agentEnvironment,
          prStatusKnown: false,
          prUnsupported: true,
        });
        return;
      }

      const probe = await probeTaskPrStatus({
        workDir: worktree.filesystemPath,
        branch,
        agentEnvironment,
      });
      if (probe.kind === 'unsupported') {
        apply(key, {
          branch,
          agentEnvironment,
          prStatusKnown: false,
          prUnsupported: true,
        });
        return;
      }
      if (probe.kind === 'transient_error') {
        const previous = state.cache.get(key);
        apply(key, {
          branch,
          agentEnvironment,
          prStatus: previous?.prStatus,
          prStatusKnown: false,
          prUnsupported: false,
          remoteBranchExists: previous?.remoteBranchExists,
        });
        return;
      }

      apply(key, {
        branch,
        agentEnvironment,
        prStatus: probe.prStatus ?? undefined,
        prStatusKnown: true,
        prUnsupported: false,
        remoteBranchExists: probe.remoteBranchExists,
      });
    } catch (error) {
      logger.warn({ error, worktreeId }, 'Worktree PR sync failed');
    } finally {
      state.inFlight.delete(key);
    }
  })();

  state.inFlight.set(key, promise);
  return promise;
}
