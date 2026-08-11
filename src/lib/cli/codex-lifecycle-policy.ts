import {
  providerIntegration,
  type ProviderIntegrationLaunchDecision,
} from './provider-integration';
import { codexAdapter } from './providers/codex/adapter';

export type CodexLifecycleOperation = 'status' | 'install' | 'update' | 'remove';

/** Shared user-global policy used by both the settings GUI and Control CLI. */
export async function manageCodexLifecycleForUser(
  userId: string,
  operation: CodexLifecycleOperation,
): Promise<ProviderIntegrationLaunchDecision> {
  const request = {
    provider: codexAdapter,
    agentEnvironmentOwner: { kind: 'user' as const, userId },
    workDir: null,
  };
  switch (operation) {
    case 'status':
      return providerIntegration.inspectLifecycle(request);
    case 'install':
      return providerIntegration.installLifecycle({ ...request, consent: 'granted' });
    case 'update':
      return providerIntegration.updateLifecycle(request);
    case 'remove':
      return providerIntegration.removeLifecycle(request);
  }
}
