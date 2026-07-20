import type { ServerTransportMessage } from '../ws/message-types';
import type { CliEnvironment } from '../cli/cli-exec';
import logger from '../logger';
import type { ProviderRateLimitsSnapshot } from '../status-display/types';
import { cliProviderRegistry } from '../cli/providers/registry';
import type { CliProvider } from '../cli/providers/provider-contract';
import { RATE_LIMIT_REFRESH_INTERVAL_MS } from './constants';

type BroadcastFn = (message: ServerTransportMessage) => void;
type EnvironmentResolver = () => CliEnvironment | Promise<CliEnvironment>;
type RateLimitUpdateMessage = Extract<ServerTransportMessage, { type: 'rate_limit_update' }>;
type ScheduleFn = (callback: () => void, delay: number) => NodeJS.Timeout;
type ClearScheduleFn = (timer: NodeJS.Timeout) => void;

type RateLimitProvider = Pick<CliProvider, 'getProviderId'>
  & Required<Pick<CliProvider, 'fetchRateLimits'>>;
type RegisteredRateLimitProvider = CliProvider & Required<Pick<CliProvider, 'fetchRateLimits'>>;

interface RateLimitPollerDependencies {
  listProviders: () => RateLimitProvider[];
  schedule?: ScheduleFn;
  clearSchedule?: ClearScheduleFn;
}

function hasRateLimitFetcher(provider: CliProvider): provider is RegisteredRateLimitProvider {
  return typeof provider.fetchRateLimits === 'function';
}

function listRegisteredProviders(): RateLimitProvider[] {
  return cliProviderRegistry.getProviderIds()
    .map((id) => cliProviderRegistry.getProvider(id))
    .filter(hasRateLimitFetcher);
}

export class RateLimitPoller {
  private interval: NodeJS.Timeout | null = null;
  private broadcastFn: BroadcastFn | null = null;
  private environmentResolver: EnvironmentResolver | null = null;
  private cachedSnapshots = new Map<string, ProviderRateLimitsSnapshot>();

  constructor(
    private readonly dependencies: RateLimitPollerDependencies = {
      listProviders: listRegisteredProviders,
    },
  ) {}

  setBroadcast(fn: BroadcastFn): void {
    this.broadcastFn = fn;
  }

  setEnvironmentResolver(fn: EnvironmentResolver | null): void {
    this.environmentResolver = fn;
  }

  getCachedSnapshots(): ProviderRateLimitsSnapshot[] {
    return [...this.cachedSnapshots.values()];
  }

  async start(): Promise<void> {
    if (this.interval) return;

    const schedule = this.dependencies.schedule ?? setInterval;
    this.interval = schedule(() => {
      void this.poll();
    }, RATE_LIMIT_REFRESH_INTERVAL_MS);

    logger.info({ intervalMs: RATE_LIMIT_REFRESH_INTERVAL_MS }, 'Rate limit poller started');

    // Fetch immediately on start.
    await this.poll();
  }

  stop(): void {
    if (this.interval) {
      const clearSchedule = this.dependencies.clearSchedule ?? clearInterval;
      clearSchedule(this.interval);
      this.interval = null;
      logger.info('Rate limit poller stopped');
    }
  }

  private async resolveEnvironment(): Promise<CliEnvironment> {
    if (!this.environmentResolver) return 'native';

    try {
      return await this.environmentResolver();
    } catch (err) {
      logger.warn({ error: err }, 'Rate limit environment resolver failed');
      return 'native';
    }
  }

  private publish(snapshot: ProviderRateLimitsSnapshot): void {
    this.cachedSnapshots.set(snapshot.providerId, snapshot);
    const message: RateLimitUpdateMessage = {
      type: 'rate_limit_update',
      ...snapshot,
    };
    this.broadcastFn?.(message);
  }

  private async poll(): Promise<void> {
    const environment = await this.resolveEnvironment();
    const providers = this.dependencies.listProviders();
    const results = await Promise.allSettled(
      providers.map((provider) => provider.fetchRateLimits({ environment })),
    );

    for (const [index, result] of results.entries()) {
      const providerId = providers[index].getProviderId();
      if (result.status === 'fulfilled') {
        if (result.value) this.publish(result.value);
      } else {
        logger.error({ error: result.reason, providerId }, 'Rate limit poll error');
      }
    }
  }
}

export const rateLimitPoller = new RateLimitPoller();
