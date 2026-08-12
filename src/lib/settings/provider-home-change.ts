import type { AgentEnvironment } from './types';
import { cliProviderRegistry } from '@/lib/cli/providers/registry';
import { providerIntegration } from '@/lib/cli/provider-integration';
import { countManagedSessionsTransitioningUnavailable } from '@/lib/db/sessions';
import type { ProviderHomeIdentity } from '@/lib/cli/providers/provider-home-identity';

interface ManagedProviderHome {
  providerId: string;
  identity: ProviderHomeIdentity;
}

interface ProviderHomeChangeDependencies {
  resolveHomes?: (
    userId: string,
    environment: AgentEnvironment,
  ) => Promise<ManagedProviderHome[]>;
  countTransitioningUnavailable?: (
    providerId: string,
    currentIdentity: ProviderHomeIdentity,
    targetIdentity: ProviderHomeIdentity,
  ) => number;
}

export interface ProviderHomeChangeImpact {
  unavailableManagedSessionCount: number;
}

export async function inspectProviderHomeChange(
  userId: string,
  current: AgentEnvironment,
  target: AgentEnvironment,
  dependencies: ProviderHomeChangeDependencies = {},
): Promise<ProviderHomeChangeImpact> {
  const resolveHomes = dependencies.resolveHomes ?? (async (
    _userId: string,
    environment: AgentEnvironment,
  ) => {
    const managedHomes: ManagedProviderHome[] = [];
    for (const providerId of cliProviderRegistry.getProviderIds()) {
      const provider = cliProviderRegistry.getProvider(providerId);
      if (!provider.bindsManagedSessionsToProviderHome?.()) continue;
      const home = await providerIntegration.resolveProviderHome({
        provider,
        agentEnvironment: environment,
        userId,
      });
      if (!home.identity) {
        throw new Error(`${provider.getDisplayName()} provider home identity is unavailable.`);
      }
      managedHomes.push({ providerId, identity: home.identity });
    }
    return managedHomes;
  });
  const [currentHomes, targetHomes] = await Promise.all([
    resolveHomes(userId, current),
    resolveHomes(userId, target),
  ]);
  const targetByProvider = new Map(targetHomes.map((home) => [home.providerId, home.identity]));
  const countTransitioningUnavailable = dependencies.countTransitioningUnavailable
    ?? countManagedSessionsTransitioningUnavailable;
  return {
    unavailableManagedSessionCount: currentHomes.reduce(
      (total, home) => {
        const targetIdentity = targetByProvider.get(home.providerId);
        if (!targetIdentity) return total;
        return total + countTransitioningUnavailable(
          home.providerId,
          home.identity,
          targetIdentity,
        );
      },
      0,
    ),
  };
}
