import type { AgentEnvironment } from './types';
import { cliProviderRegistry } from '@/lib/cli/providers/registry';
import { providerIntegration } from '@/lib/cli/provider-integration';
import { countManagedCodexSessionsUnavailableInHome } from '@/lib/db/sessions';

interface ProviderHomeChangeDependencies {
  resolveTargetIdentity?: (
    userId: string,
    target: AgentEnvironment,
  ) => Promise<string>;
  countUnavailable?: (identity: string) => number;
}

export interface ProviderHomeChangeImpact {
  targetProviderHomeIdentity: string;
  unavailableManagedSessionCount: number;
}

export async function inspectProviderHomeChange(
  userId: string,
  target: AgentEnvironment,
  dependencies: ProviderHomeChangeDependencies = {},
): Promise<ProviderHomeChangeImpact> {
  const resolveTargetIdentity = dependencies.resolveTargetIdentity ?? (async () => {
    const home = await providerIntegration.resolveProviderHome({
      provider: cliProviderRegistry.getProvider('codex'),
      agentEnvironment: target,
      userId,
    });
    if (!home.identity) throw new Error('Codex provider home identity is unavailable.');
    return home.identity;
  });
  const identity = await resolveTargetIdentity(userId, target);
  return {
    targetProviderHomeIdentity: identity,
    unavailableManagedSessionCount: (
      dependencies.countUnavailable ?? countManagedCodexSessionsUnavailableInHome
    )(identity),
  };
}
