import {
  createProviderIntegration,
  ProviderIntegrationEnvironmentError,
  type ProviderIntegrationLaunchDecision,
} from '@/lib/cli/provider-integration';
import { codexAdapter } from '@/lib/cli/providers/codex/adapter';
import { ControlOperationError } from './service';

export interface ControlProviderIntegrationManager {
  inspectCodexLifecycle(): Promise<ProviderIntegrationLaunchDecision>;
  installCodexLifecycle(): Promise<ProviderIntegrationLaunchDecision>;
}

export function createControlProviderIntegrationManager(options: {
  resolveUserId: () => Promise<string>;
}): ControlProviderIntegrationManager {
  const integration = createProviderIntegration();
  const request = async () => ({
    provider: codexAdapter,
    agentEnvironmentOwner: {
      kind: 'user' as const,
      userId: await options.resolveUserId(),
    },
    workDir: null,
  });
  const failClosed = async (
    operation: () => Promise<ProviderIntegrationLaunchDecision>,
  ): Promise<ProviderIntegrationLaunchDecision> => {
    try {
      return await operation();
    } catch (error) {
      if (!(error instanceof ProviderIntegrationEnvironmentError)) throw error;
      throw new ControlOperationError(
        'INSTANCE_UNAVAILABLE',
        'The current Agent Environment could not be resolved. Check Tessera Settings and retry.',
        503,
      );
    }
  };

  return {
    async inspectCodexLifecycle() {
      return failClosed(async () => integration.inspectLifecycle(await request()));
    },
    async installCodexLifecycle() {
      return failClosed(async () => integration.installLifecycle({
        ...await request(),
        consent: 'granted',
      }));
    },
  };
}
