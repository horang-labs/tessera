/**
 * Session-scoped PR detection for sessions that aren't tied to a kanban task.
 *
 * Mirrors the task-pr-sync surface but stores results in an in-memory cache
 * keyed by sessionId rather than the tasks table — bare sessions don't own
 * a row that can carry PR state. The cache is recomputed on demand
 * (refresh-git endpoint, agent turn-end, background poll) and lost on
 * server restart, which is fine: probes are cheap and the next access
 * recomputes within ~200ms.
 */

import * as dbSessions from '@/lib/db/sessions';
import logger from '@/lib/logger';
import type { AgentEnvironment } from '@/lib/settings/types';
import type { TaskPrStatus } from '@/types/task-pr-status';
import { probeTaskPrStatus, resolveCurrentBranch } from './pr-status-provider';

export interface SessionPrCacheEntry {
  prStatus?: TaskPrStatus;
  prUnsupported: boolean;
  remoteBranchExists?: boolean;
  lastSyncedAt: number;
}

export interface SessionPrUpdate {
  sessionId: string;
  prStatus?: TaskPrStatus;
  prUnsupported: boolean;
  remoteBranchExists?: boolean;
}

interface EligibleSessionPrRow {
  id: string;
  work_dir: string | null;
}

type Listener = (update: SessionPrUpdate) => void;

const GLOBAL_KEY = Symbol.for('tessera.sessionPrSync');
interface SyncState {
  cache: Map<string, SessionPrCacheEntry>;
  listeners: Set<Listener>;
  inFlight: Map<string, Promise<void>>;
}

const g = globalThis as unknown as { [GLOBAL_KEY]?: SyncState };

function getState(): SyncState {
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = {
      cache: new Map(),
      listeners: new Set(),
      inFlight: new Map(),
    };
  }
  return g[GLOBAL_KEY]!;
}

export function subscribeSessionPrUpdates(listener: Listener): () => void {
  const state = getState();
  state.listeners.add(listener);
  return () => {
    state.listeners.delete(listener);
  };
}

export function getCachedSessionPr(sessionId: string): SessionPrCacheEntry | undefined {
  return getState().cache.get(sessionId);
}

export function clearCachedSessionPr(sessionId: string): void {
  getState().cache.delete(sessionId);
}

function notify(update: SessionPrUpdate): void {
  for (const listener of getState().listeners) {
    try {
      listener(update);
    } catch (err) {
      logger.warn({ err, sessionId: update.sessionId }, 'Session PR subscriber threw');
    }
  }
}

function prStatusesEqual(a: TaskPrStatus | undefined, b: TaskPrStatus | undefined): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return (
    a.number === b.number &&
    a.state === b.state &&
    a.url === b.url &&
    (a.mergedAt ?? null) === (b.mergedAt ?? null)
  );
}

/**
 * Probe a single session's PR state. Skips sessions that have a task_id
 * (those go through syncTaskPr) or no work_dir. Idempotent and coalesced
 * per sessionId.
 */
export function syncSessionPr(
  sessionId: string,
  options: { agentEnvironment?: AgentEnvironment } = {},
): Promise<void> {
  const state = getState();
  const existing = state.inFlight.get(sessionId);
  if (existing) return existing;

  const promise = (async () => {
    try {
      const session = dbSessions.getSession(sessionId);
      if (!session) return;
      // Sessions linked to a task go through the task pipeline so the kanban
      // badge stays the source of truth.
      if (session.task_id) return;
      if (!session.work_dir) return;

      const branch = await resolveCurrentBranch(session.work_dir, options.agentEnvironment);
      if (!branch) {
        markUnsupportedIfChanged(sessionId);
        return;
      }

      const probe = await probeTaskPrStatus({
        workDir: session.work_dir,
        branch,
        agentEnvironment: options.agentEnvironment,
      });

      if (probe.kind === 'unsupported') {
        markUnsupportedIfChanged(sessionId);
        return;
      }

      if (probe.kind === 'transient_error') {
        // Same rule as task sync: leave the previously-known state in place.
        return;
      }

      const nextStatus = probe.prStatus ?? undefined;
      const nextRemote = probe.remoteBranchExists;
      const previous = state.cache.get(sessionId);
      const unchanged =
        previous
        && previous.prUnsupported === false
        && previous.remoteBranchExists === nextRemote
        && prStatusesEqual(previous.prStatus, nextStatus);
      if (unchanged) return;

      applyAndNotify(sessionId, {
        prStatus: nextStatus,
        prUnsupported: false,
        remoteBranchExists: nextRemote,
      });
    } catch (err) {
      logger.warn({ err, sessionId }, 'Session PR sync failed');
    } finally {
      state.inFlight.delete(sessionId);
    }
  })();

  state.inFlight.set(sessionId, promise);
  return promise;
}

function applyAndNotify(sessionId: string, payload: Omit<SessionPrUpdate, 'sessionId'>): void {
  const state = getState();
  state.cache.set(sessionId, {
    prStatus: payload.prStatus,
    prUnsupported: payload.prUnsupported,
    remoteBranchExists: payload.remoteBranchExists,
    lastSyncedAt: Date.now(),
  });
  notify({ sessionId, ...payload });
}

function markUnsupportedIfChanged(sessionId: string): void {
  const previous = getState().cache.get(sessionId);
  if (previous?.prUnsupported === true) {
    // Cache already reflects unsupported state — skip broadcast so the
    // 60s poll doesn't spam clients with no-op messages for non-GitHub
    // repos, missing branches, or unauthenticated gh.
    return;
  }
  applyAndNotify(sessionId, { prUnsupported: true });
}

/**
 * Sweep sessions that have a workdir but no task_id. The background poller
 * passes the live runtime IDs so historical sessions do not generate WSL/gh
 * work; callers may omit the filter for an explicit full reconciliation.
 */
export async function syncAllEligibleSessionPrs(
  options: {
    agentEnvironment?: AgentEnvironment;
    sessionIds?: ReadonlySet<string>;
  } = {},
): Promise<void> {
  const rows = filterEligibleSessionPrRows(
    dbSessions.getSessionsEligibleForBareSessionPrSync(),
    options.sessionIds,
  );
  const CONCURRENCY = 3;
  let cursor = 0;

  const worker = async () => {
    while (cursor < rows.length) {
      const idx = cursor++;
      const row = rows[idx];
      if (!row) break;
      await syncSessionPr(row.id, options);
    }
  };

  const workers = Array.from({ length: Math.min(CONCURRENCY, rows.length) }, () => worker());
  await Promise.all(workers);
}

export function filterEligibleSessionPrRows<T extends EligibleSessionPrRow>(
  rows: T[],
  sessionIds?: ReadonlySet<string>,
): T[] {
  if (!sessionIds) return rows;
  return rows.filter((row) => sessionIds.has(row.id));
}
