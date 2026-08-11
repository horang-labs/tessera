import type { AgentEnvironment } from '@/lib/settings/types';
import type {
  CliProvider,
  ProviderIntegrationRequirements,
} from './providers/provider-contract';
import { getAgentEnvironment, resolveDefaultAgentEnvironment } from './spawn-cli';
import {
  createProviderSkillManager,
  detectSupportedProviderSkills,
  PROVIDER_SKILL_IDS,
  resolveOwnedProviderSkillHome,
  type ProviderSkillId,
  type ProviderSkillManagementRequest,
  type ProviderSkillManagementResult,
  type ProviderSkillManagerOptions,
} from './provider-skill-management';

export type {
  ProviderSkillId,
  ProviderSkillManagementRequest,
  ProviderSkillManagementResult,
} from './provider-skill-management';

export type ProviderIntegrationArtifactState =
  | 'unchecked'
  | 'ready'
  | 'stale'
  | 'absent'
  | 'conflict'
  | 'not-applicable';

export type ProviderIntegrationConsentState =
  | 'unchecked'
  | 'not-required'
  | 'granted'
  | 'revoked'
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
  manageSkills(request: ProviderSkillManagementRequest): Promise<ProviderSkillManagementResult>;
}

interface ProviderIntegrationOptions extends Partial<Omit<
  ProviderSkillManagerOptions,
  'resolveAgentEnvironment' | 'resolveDefaultEnvironment'
>> {
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
 * Callers receive domain decisions only; provider-home paths and skill
 * ownership stay behind the shared integration boundary.
 */
export function createProviderIntegration(
  options: ProviderIntegrationOptions = {},
): ProviderIntegration {
  const resolveAgentEnvironment = options.resolveAgentEnvironment ?? getAgentEnvironment;
  const resolveDefaultEnvironment = options.resolveDefaultEnvironment
    ?? (async () => resolveDefaultAgentEnvironment());
  const skillManager = createProviderSkillManager({
    resolveAgentEnvironment,
    resolveDefaultEnvironment,
    detectSkillProviders: options.detectSkillProviders ?? detectSupportedProviderSkills,
    resolveProviderSkillHome: options.resolveProviderSkillHome ?? resolveOwnedProviderSkillHome,
    ...(options.providerSkillStateDirectory
      ? { providerSkillStateDirectory: options.providerSkillStateDirectory }
      : {}),
    ...(options.readProviderSkillFiles
      ? { readProviderSkillFiles: options.readProviderSkillFiles }
      : {}),
  });

  return {
    manageSkills: (request) => skillManager.manage(request),
    async resolveLaunch(request) {
      const agentEnvironment = request.agentEnvironmentOwner.kind === 'user'
        ? await resolveAgentEnvironment(request.agentEnvironmentOwner.userId)
        : await resolveDefaultEnvironment();
      const requirements = request.provider.getProviderIntegrationRequirements?.()
        ?? DEFAULT_REQUIREMENTS;
      let skill = resolveArtifactPolicy(requirements.skill);
      let health: ProviderIntegrationHealth = { state: 'unchecked' };
      if (requirements.skill !== 'not-applicable') {
        try {
          const maintained = await skillManager.maintain(
            request.agentEnvironmentOwner,
            normalizeProviderSkillId(request.provider.getProviderId()),
            agentEnvironment,
          );
          skill = {
            requirement: requirements.skill,
            state: maintained.status.state === 'unavailable'
              ? 'conflict'
              : maintained.status.state,
            consent: maintained.status.consent === 'not-granted'
              ? 'declined'
              : maintained.status.consent,
          };
          health = maintained.status.state === 'ready'
            ? { state: 'healthy' }
            : maintained.status.state === 'conflict' || maintained.status.state === 'unavailable'
              ? { state: 'degraded' }
              : { state: 'unchecked' };
        } catch {
          // Provider skills are optional. Environment, ownership, and filesystem
          // failures are surfaced by management commands but never block launch.
          skill = {
            requirement: requirements.skill,
            state: 'conflict',
            consent: 'unchecked',
          };
          health = { state: 'degraded' };
        }
      }
      return {
        providerHome: {
          owner: 'agent-environment',
          agentEnvironment,
        },
        lifecycle: resolveArtifactPolicy(requirements.lifecycle),
        skill,
        health,
      };
    },
  };
}

function normalizeProviderSkillId(providerId: string): ProviderSkillId {
  if ((PROVIDER_SKILL_IDS as readonly string[]).includes(providerId)) {
    return providerId as ProviderSkillId;
  }
  throw new Error(`Provider ${providerId} does not support the tessera-cli skill.`);
}

export const providerIntegration = createProviderIntegration();
