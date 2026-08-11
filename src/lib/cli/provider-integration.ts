import type { AgentEnvironment } from '@/lib/settings/types';
import type {
  CliProvider,
  ProviderIntegrationRequirements,
} from './providers/provider-contract';
import { getAgentEnvironment, resolveDefaultAgentEnvironment } from './spawn-cli';

export type ProviderIntegrationArtifactState =
  | 'unchecked'
  | 'ready'
  | 'absent'
  | 'conflict'
  | 'not-applicable';

export type ProviderIntegrationConsentState =
  | 'unchecked'
  | 'not-required'
  | 'granted'
  | 'declined';

export interface ProviderIntegrationArtifactPolicy {
  requirement: 'required' | 'optional' | 'not-applicable';
  state: ProviderIntegrationArtifactState;
  consent: ProviderIntegrationConsentState;
}

export interface ProviderIntegrationHealth {
  state: 'unchecked' | 'healthy' | 'degraded' | 'blocked';
}

export interface ProviderIntegrationLaunchDecision {
  providerHome: {
    owner: 'agent-environment';
    agentEnvironment: AgentEnvironment;
  };
  lifecycle: ProviderIntegrationArtifactPolicy;
  skill: ProviderIntegrationArtifactPolicy;
  health: ProviderIntegrationHealth;
}

export interface ProviderIntegrationLaunchRequest {
  provider: Pick<CliProvider, 'getProviderId' | 'getProviderIntegrationRequirements'>;
  agentEnvironmentOwner:
    | { kind: 'user'; userId: string }
    | { kind: 'server-default' };
}

export interface ProviderIntegration {
  resolveLaunch(
    request: ProviderIntegrationLaunchRequest,
  ): Promise<ProviderIntegrationLaunchDecision>;
}

interface ProviderIntegrationOptions {
  resolveAgentEnvironment?: (userId: string) => Promise<AgentEnvironment>;
  resolveDefaultEnvironment?: () => Promise<AgentEnvironment>;
}

const DEFAULT_REQUIREMENTS: ProviderIntegrationRequirements = {
  lifecycle: 'not-applicable',
  skill: 'optional',
};

function resolveArtifactPolicy(
  requirement: ProviderIntegrationArtifactPolicy['requirement'],
): ProviderIntegrationArtifactPolicy {
  return requirement === 'not-applicable'
    ? {
        requirement,
        state: 'not-applicable',
        consent: 'not-required',
      }
    : {
        requirement,
        state: 'unchecked',
        consent: 'unchecked',
      };
}

/**
 * Shared policy boundary for provider launches.
 *
 * This prefactor deliberately records current policy without implementing the
 * later real-home, hook, skill-management, consent, conflict, or health work.
 * Callers receive domain decisions only; filesystem paths stay behind their
 * existing launch mechanisms.
 */
export function createProviderIntegration(
  options: ProviderIntegrationOptions = {},
): ProviderIntegration {
  const resolveAgentEnvironment = options.resolveAgentEnvironment ?? getAgentEnvironment;
  const resolveDefaultEnvironment = options.resolveDefaultEnvironment
    ?? (async () => resolveDefaultAgentEnvironment());

  return {
    async resolveLaunch(request) {
      const agentEnvironment = request.agentEnvironmentOwner.kind === 'user'
        ? await resolveAgentEnvironment(request.agentEnvironmentOwner.userId)
        : await resolveDefaultEnvironment();
      const requirements = request.provider.getProviderIntegrationRequirements?.()
        ?? DEFAULT_REQUIREMENTS;
      return {
        providerHome: {
          owner: 'agent-environment',
          agentEnvironment,
        },
        lifecycle: resolveArtifactPolicy(requirements.lifecycle),
        skill: resolveArtifactPolicy(requirements.skill),
        health: { state: 'unchecked' },
      };
    },
  };
}

export const providerIntegration = createProviderIntegration();
