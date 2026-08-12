import { providerIntegration } from '@/lib/cli/provider-integration';

/** Add live provider health to a persisted Session projection when it is managed. */
export function withManagedSessionIntegrationHealth<T extends { id: string }>(
  session: T,
): T & { integrationHealth?: 'healthy' | 'degraded' } {
  const integrationHealth = providerIntegration.getManagedSessionHealth(session.id);
  return integrationHealth ? { ...session, integrationHealth } : session;
}
