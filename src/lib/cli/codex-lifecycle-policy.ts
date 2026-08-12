import {
  providerIntegration,
  type ProviderIntegrationLaunchDecision,
} from './provider-integration';
import { codexAdapter } from './providers/codex/adapter';
import {
  dispatchCodexLifecycleOperation,
  type CodexLifecycleOperation,
} from './codex-lifecycle-operations';

export type { CodexLifecycleOperation } from './codex-lifecycle-operations';

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
  return dispatchCodexLifecycleOperation(operation, {
    status: () => providerIntegration.inspectLifecycle(request),
    install: () => providerIntegration.installLifecycle({ ...request, consent: 'granted' }),
    update: () => providerIntegration.updateLifecycle(request),
    reconcile: () => providerIntegration.reconcileLifecycle(request),
    remove: () => providerIntegration.removeLifecycle(request),
  });
}
