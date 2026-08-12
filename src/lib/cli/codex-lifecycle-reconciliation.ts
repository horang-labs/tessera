import logger from '@/lib/logger';
import { providerIntegration } from './provider-integration';
import { codexAdapter } from './providers/codex/adapter';

export async function reconcileCodexLifecycleForUser(
  userId: string,
  enabled: boolean,
): Promise<void> {
  const request = {
    provider: codexAdapter,
    agentEnvironmentOwner: { kind: 'user' as const, userId },
    workDir: null,
  };
  const decision = enabled
    ? await providerIntegration.reconcileLifecycle(request)
    : await providerIntegration.removeLifecycle(request);
  if (enabled && decision.health.state !== 'healthy') {
    logger.warn({ userId, lifecycle: decision.lifecycle }, 'Codex lifecycle reconciliation needs attention');
  }
}

export function reconcileCodexLifecycleForUserSoon(userId: string, enabled: boolean): void {
  void reconcileCodexLifecycleForUser(userId, enabled).catch((error) => {
    logger.warn({ userId, error }, 'Codex lifecycle reconciliation skipped');
  });
}
