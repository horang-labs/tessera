import { getRateLimitData, hasOAuthCredentials, type RateLimitData } from './fetcher';
import type { ServerTransportMessage } from '../ws/message-types';
import logger from '../logger';
import { buildClaudeRateLimitSnapshot } from '../status-display/rate-limit-snapshots';

const POLL_INTERVAL_MS = 300_000; // 5 minutes

type BroadcastFn = (message: ServerTransportMessage) => void;

class RateLimitPoller {
  private interval: NodeJS.Timeout | null = null;
  private broadcastFn: BroadcastFn | null = null;

  setBroadcast(fn: BroadcastFn): void {
    this.broadcastFn = fn;
  }

  async start(): Promise<void> {
    const hasOAuth = await hasOAuthCredentials();
    if (!hasOAuth) {
      logger.info('Rate limit poller: no OAuth credentials, skipping');
      return;
    }

    // Fetch immediately on start
    await this.poll();

    this.interval = setInterval(() => {
      this.poll();
    }, POLL_INTERVAL_MS);

    logger.info({ intervalMs: POLL_INTERVAL_MS }, 'Rate limit poller started');
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
      logger.info('Rate limit poller stopped');
    }
  }

  private async poll(): Promise<void> {
    try {
      const data = await getRateLimitData();
      if (data && this.broadcastFn) {
        this.broadcastFn({
          type: 'rate_limit_update',
          ...buildClaudeRateLimitSnapshot(data),
        });
      }
    } catch (err) {
      logger.error({ error: err }, 'Rate limit poll error');
    }
  }
}

export const rateLimitPoller = new RateLimitPoller();
