import type { AgentEnvironment } from './types';
import { cliProviderRegistry } from '@/lib/cli/providers/registry';
import { providerIntegration } from '@/lib/cli/provider-integration';
import { countManagedSessionsUnavailableInHome } from '@/lib/db/sessions';
import type { ProviderHomeIdentity } from '@/lib/cli/providers/provider-home-identity';

interface ManagedProviderHome {
  providerId: string;
  identity: ProviderHomeIdentity;
}

interface ProviderHomeChangeDependencies {
  resolveTargetHomes?: (
    userId: string,
    target: AgentEnvironment,
  ) => Promise<ManagedProviderHome[]>;
  countUnavailable?: (providerId: string, identity: ProviderHomeIdentity) => number;
}

export interface ProviderHomeChangeImpact {
  unavailableManagedSessionCount: number;
}

export async function inspectProviderHomeChange(
  userId: string,
  target: AgentEnvironment,
  dependencies: ProviderHomeChangeDependencies = {},
): Promise<ProviderHomeChangeImpact> {
  const resolveTargetHomes = dependencies.resolveTargetHomes ?? (async () => {
    const managedHomes: ManagedProviderHome[] = [];
    for (const providerId of cliProviderRegistry.getProviderIds()) {
      const provider = cliProviderRegistry.getProvider(providerId);
      if (!provider.bindsManagedSessionsToProviderHome?.()) continue;
      const home = await providerIntegration.resolveProviderHome({
        provider,
        agentEnvironment: target,
        userId,
      });
      if (!home.identity) {
        throw new Error(`${provider.getDisplayName()} provider home identity is unavailable.`);
      }
      managedHomes.push({ providerId, identity: home.identity });
    }
    return managedHomes;
  });
  const homes = await resolveTargetHomes(userId, target);
  const countUnavailable = dependencies.countUnavailable
    ?? countManagedSessionsUnavailableInHome;
  return {
    unavailableManagedSessionCount: homes.reduce(
      (total, home) => total + countUnavailable(home.providerId, home.identity),
      0,
    ),
  };
}
