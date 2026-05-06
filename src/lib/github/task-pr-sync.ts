/**
 * Sync a task's GitHub PR state into our DB and fan out change events.
 *
 * Two entry points:
 *   - `syncTaskPr(taskId)` — probe one task (used after an agent turn ends).
 *   - `syncAllEligibleTaskPrs()` — sweep every branch-bound task, used by
 *     the background poller.
 *
 * Subscribers get notified only when something actually changed (to keep
 * WebSocket traffic minimal).
 */

import * as dbTasks from '@/lib/db/tasks';
import logger from '@/lib/logger';
import type { AgentEnvironment } from '@/lib/settings/types';
import type { TaskPrStatus } from '@/types/task-pr-status';
import { probeTaskPrStatus } from './pr-status-provider';

export interface TaskPrUpdate {
  taskId: string;
  prStatus?: TaskPrStatus;
  prUnsupported: boolean;
  remoteBranchExists?: boolean;
}

type Listener = (update: TaskPrUpdate) => void;

const GLOBAL_KEY = Symbol.for('tessera.taskPrSync');
interface SyncState {
  listeners: Set<Listener>;
  inFlight: Map<string, Promise<void>>;
}

const g = globalThis as unknown as { [GLOBAL_KEY]?: SyncState };

function getState(): SyncState {
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = {
      listeners: new Set(),
      inFlight: new Map(),
    };
  }
  return g[GLOBAL_KEY]!;
}

export function subscribeTaskPrUpdates(listener: Listener): () => void {
  const state = getState();
  state.listeners.add(listener);
  return () => {
    state.listeners.delete(listener);
  };
}

function notify(update: TaskPrUpdate): void {
  for (const listener of getState().listeners) {
    try {
      listener(update);
    } catch (err) {
      logger.warn({ err, taskId: update.taskId }, 'Task PR subscriber threw');
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
 * Probe a single task. Updates DB only when the derived state changes and
 * broadcasts the update to subscribers. Concurrent calls for the same taskId
 * coalesce on a shared promise.
 */
export function syncTaskPr(
  taskId: string,
  options: { agentEnvironment?: AgentEnvironment } = {},
): Promise<void> {
  const state = getState();
  const existing = state.inFlight.get(taskId);
  if (existing) return existing;

  const promise = (async () => {
    try {
      const row = dbTasks.getTaskPrSyncContext(taskId);
      if (!row) return;
      if (!row.workDir || !row.branch) {
        // Tasks with no branch/workDir are permanently unsupported.
        if (!row.wasUnsupported) {
          dbTasks.setTaskPrStatus(taskId, { unsupported: true });
          notify({ taskId, prUnsupported: true });
        }
        return;
      }

      const probe = await probeTaskPrStatus({
        workDir: row.workDir,
        branch: row.branch,
        agentEnvironment: options.agentEnvironment,
      });

      if (probe.kind === 'unsupported') {
        if (!row.wasUnsupported) {
          dbTasks.setTaskPrStatus(taskId, { unsupported: true });
          notify({ taskId, prUnsupported: true });
          logger.info({ taskId, reason: probe.reason }, 'Task marked PR-unsupported');
        }
        return;
      }

      // Keep the DB-stored branch in sync with the worktree's actual HEAD so
      // downstream UI (Git panel, tooltips, list rows) agrees with reality.
      // Skipped when HEAD is detached — probe reports resolvedBranch=null.
      if (probe.resolvedBranch && probe.resolvedBranch !== row.branch) {
        dbTasks.setTaskWorktreeBranch(taskId, probe.resolvedBranch);
      }

      const nextStatus = probe.prStatus ?? null;
      const nextRemoteExists = probe.remoteBranchExists;
      const prUnchanged =
        !row.wasUnsupported && prStatusesEqual(row.prStatus, nextStatus ?? undefined);
      const remoteUnchanged = row.remoteBranchExists === nextRemoteExists;
      if (prUnchanged && remoteUnchanged) return;

      dbTasks.setTaskPrStatus(taskId, {
        unsupported: false,
        prStatus: nextStatus,
        remoteBranchExists: nextRemoteExists,
      });
      notify({
        taskId,
        prStatus: nextStatus ?? undefined,
        prUnsupported: false,
        remoteBranchExists: nextRemoteExists,
      });
    } catch (err) {
      logger.warn({ err, taskId }, 'Task PR sync failed');
    } finally {
      state.inFlight.delete(taskId);
    }
  })();

  state.inFlight.set(taskId, promise);
  return promise;
}

/**
 * Sweep every branch-bound task. We serialize per-task syncs with a small
 * concurrency cap to avoid stampeding gh/GitHub.
 */
export async function syncAllEligibleTaskPrs(
  options: { agentEnvironment?: AgentEnvironment } = {},
): Promise<void> {
  const rows = dbTasks.getTasksEligibleForPrSync();
  const CONCURRENCY = 3;
  let cursor = 0;

  const worker = async () => {
    while (cursor < rows.length) {
      const idx = cursor++;
      const row = rows[idx];
      if (!row) break;
      await syncTaskPr(row.id, options);
    }
  };

  const workers = Array.from({ length: Math.min(CONCURRENCY, rows.length) }, () => worker());
  await Promise.all(workers);
}
