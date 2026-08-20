/**
 * Background poller that periodically sweeps every branch-bound task and
 * reconciles its stored PR state with GitHub. Event-driven sync (after an
 * agent turn ends) handles most updates — this poller exists to catch
 * changes made outside the Tessera (team merge, branch delete, etc.).
 */

import logger from '@/lib/logger';
import { isElectronRuntime } from '@/lib/electron-runtime';
import { resolveServerDefaultUserId } from '@/lib/server-default-user';
import { SettingsManager } from '@/lib/settings/manager';
import { getActiveSessionIds } from '@/lib/session/active-session-runtime';
import * as dbSessions from '@/lib/db/sessions';
import type { AgentEnvironment } from '@/lib/settings/types';
import { syncAllEligibleTaskPrs } from './task-pr-sync';
import { syncAllEligibleSessionPrs } from './session-pr-sync';

// 60s strikes a balance between staleness and gh-CLI / GitHub-API load.
// The probe coalesces in-flight requests per task and only writes the DB
// (+ broadcasts) when something actually changed, so a tighter cadence
// stays cheap. Overrides via TESSERA_PR_POLL_INTERVAL_MS for testing.
const DEFAULT_POLL_INTERVAL_MS = 60_000;
const POLL_INTERVAL_MS = (() => {
  const raw = process.env.TESSERA_PR_POLL_INTERVAL_MS;
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed >= 5_000
    ? parsed
    : DEFAULT_POLL_INTERVAL_MS;
})();

class TaskPrPoller {
  private interval: NodeJS.Timeout | null = null;
  private running = false;

  async start(): Promise<void> {
    if (this.interval) return;

    if (process.env.DISABLE_TASK_PR_POLLER === '1') {
      logger.info('Task PR poller: disabled via DISABLE_TASK_PR_POLLER env');
      return;
    }

    // Kick off an initial sweep so existing tasks get their PR state soon
    // after server startup, then settle into the interval cadence.
    void this.pollOnce('startup');

    this.interval = setInterval(() => {
      void this.pollOnce('scheduled');
    }, POLL_INTERVAL_MS);

    logger.info({ intervalMs: POLL_INTERVAL_MS }, 'Task PR poller started');
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
      logger.info('Task PR poller stopped');
    }
  }

  private async pollOnce(reason: string): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const startedAt = Date.now();
      const agentEnvironment = await resolvePollerAgentEnvironment();
      const activeSessionIds = getActiveSessionIds();
      const activeTaskIds = new Set(
        [...activeSessionIds]
          .map((sessionId) => dbSessions.getSession(sessionId)?.task_id)
          .filter((taskId): taskId is string => Boolean(taskId)),
      );
      // Never turn a periodic refresh into a database-sized process launch.
      // Turn-end hooks refresh individual tasks; this backstop only covers the
      // handful of tasks that still own a live runtime.
      await syncAllEligibleTaskPrs({ agentEnvironment, taskIds: activeTaskIds });
      // Bare-session PR state is only visible for live runtimes. Sweeping every
      // historical session at startup can launch hundreds of WSL/gh probes and
      // contend with terminal input while the first session is opening.
      await syncAllEligibleSessionPrs({
        agentEnvironment,
        sessionIds: activeSessionIds,
      });
      logger.debug({ reason, durationMs: Date.now() - startedAt }, 'PR poll complete');
    } catch (err) {
      logger.error({ err, reason }, 'PR poll error');
    } finally {
      this.running = false;
    }
  }
}

export const taskPrPoller = new TaskPrPoller();

async function resolvePollerAgentEnvironment(): Promise<AgentEnvironment | undefined> {
  if (!isElectronRuntime()) return undefined;

  try {
    const userId = await resolveServerDefaultUserId();
    if (!userId) return undefined;
    const settings = await SettingsManager.load(userId, { silent: true });
    return settings.agentEnvironment;
  } catch {
    return undefined;
  }
}
