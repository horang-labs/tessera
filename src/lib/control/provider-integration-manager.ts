import {
  ProviderIntegrationEnvironmentError,
  type ProviderIntegrationLaunchDecision,
} from '@/lib/cli/provider-integration';
import { manageCodexLifecycleForUser } from '@/lib/cli/codex-lifecycle-policy';
import { ControlOperationError } from './service';

export interface ControlProviderIntegrationManager {
  inspectCodexLifecycle(): Promise<ProviderIntegrationLaunchDecision>;
  installCodexLifecycle(): Promise<ProviderIntegrationLaunchDecision>;
  updateCodexLifecycle(): Promise<ProviderIntegrationLaunchDecision>;
  removeCodexLifecycle(): Promise<ProviderIntegrationLaunchDecision>;
}

export function createControlProviderIntegrationManager(options: {
  resolveUserId: () => Promise<string>;
}): ControlProviderIntegrationManager {
  const manage = async (operation: 'status' | 'install' | 'update' | 'remove') => (
    manageCodexLifecycleForUser(await options.resolveUserId(), operation)
  );
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
      return failClosed(async () => manage('status'));
    },
    async installCodexLifecycle() {
      return failClosed(async () => manage('install'));
    },
    async updateCodexLifecycle() {
      return failClosed(async () => manage('update'));
    },
    async removeCodexLifecycle() {
      return failClosed(async () => manage('remove'));
    },
  };
}
