/**
 * Background poller that periodically sweeps every branch-bound task and
 * reconciles its stored PR state with GitHub. Event-driven sync (after an
 * agent turn ends) handles most updates — this poller exists to catch
 * changes made outside the Tessera (team merge, branch delete, etc.).
 */

import logger from '@/lib/logger';
import { isElectronAuthBypassEnabled } from '@/lib/auth/electron-mode';
import { getElectronAuthUserId } from '@/lib/auth/electron-user';
import { SettingsManager } from '@/lib/settings/manager';
import type { AgentEnvironment } from '@/lib/settings/types';
import { syncAllEligibleTaskPrs } from './task-pr-sync';

const POLL_INTERVAL_MS = 600_000; // 10 minutes

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
      await syncAllEligibleTaskPrs({ agentEnvironment: await resolvePollerAgentEnvironment() });
      logger.debug({ reason, durationMs: Date.now() - startedAt }, 'Task PR poll complete');
    } catch (err) {
      logger.error({ err, reason }, 'Task PR poll error');
    } finally {
      this.running = false;
    }
  }
}

export const taskPrPoller = new TaskPrPoller();

async function resolvePollerAgentEnvironment(): Promise<AgentEnvironment | undefined> {
  if (!isElectronAuthBypassEnabled()) return undefined;

  try {
    const userId = await getElectronAuthUserId();
    const settings = await SettingsManager.load(userId, { silent: true });
    return settings.agentEnvironment;
  } catch {
    return undefined;
  }
}
