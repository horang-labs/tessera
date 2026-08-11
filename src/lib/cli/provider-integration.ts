import type { AgentEnvironment } from '@/lib/settings/types';
import type {
  CliProvider,
  ProviderIntegrationRequirements,
} from './providers/provider-contract';
import { getAgentEnvironmentStrict, resolveDefaultAgentEnvironment } from './spawn-cli';
import type {
  ProviderLifecycleIntegration,
  ProviderLifecycleResult,
} from './providers/provider-contract';
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
  | 'installed'
  | 'conflict'
  | 'unavailable'
  | 'not-applicable';

export type ProviderIntegrationConsentState =
  | 'unchecked'
  | 'not-required'
  | 'required'
  | 'granted'
  | 'revoked'
  | 'declined';

export type ProviderIntegrationTrustState =
  | 'unchecked'
  | 'not-required'
  | 'trusted'
  | 'untrusted'
  | 'unavailable';

export interface ProviderIntegrationArtifactPolicy {
  requirement: 'required' | 'optional' | 'not-applicable';
  state: ProviderIntegrationArtifactState;
  consent: ProviderIntegrationConsentState;
  trust: ProviderIntegrationTrustState;
  message?: string;
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
  guidance?: {
    minimumVersion: string;
    updateCommand: string;
    message: string;
  };
}

export interface ProviderIntegrationLaunchRequest {
  provider: Pick<
    CliProvider,
    'getProviderId' | 'getProviderIntegrationRequirements' | 'getLifecycleIntegration'
  >;
  agentEnvironmentOwner:
    | { kind: 'user'; userId: string }
    | { kind: 'server-default' };
}

export interface ProviderIntegrationLifecycleRequest extends ProviderIntegrationLaunchRequest {
  workDir?: string | null;
}

export interface ProviderIntegrationLifecycleInstallRequest
  extends ProviderIntegrationLifecycleRequest {
  consent: 'granted' | 'declined';
}

export interface ProviderIntegration {
  resolveLaunch(
    request: ProviderIntegrationLaunchRequest,
  ): Promise<ProviderIntegrationLaunchDecision>;
  inspectLifecycle(
    request: ProviderIntegrationLifecycleRequest,
  ): Promise<ProviderIntegrationLaunchDecision>;
  installLifecycle(
    request: ProviderIntegrationLifecycleInstallRequest,
  ): Promise<ProviderIntegrationLaunchDecision>;
  manageSkills(request: ProviderSkillManagementRequest): Promise<ProviderSkillManagementResult>;
}

interface ProviderIntegrationOptions extends Partial<Omit<
  ProviderSkillManagerOptions,
  'resolveAgentEnvironment' | 'resolveDefaultEnvironment'
>> {
  resolveAgentEnvironment?: (userId: string) => Promise<AgentEnvironment>;
  resolveDefaultEnvironment?: () => Promise<AgentEnvironment>;
  lifecycle?: ProviderLifecycleIntegration;
}

export class ProviderIntegrationEnvironmentError extends Error {
  constructor(readonly cause: unknown) {
    super('The current Agent Environment could not be resolved.');
    this.name = 'ProviderIntegrationEnvironmentError';
  }
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
        trust: 'not-required',
      }
    : {
        requirement,
        state: 'unchecked',
        consent: 'unchecked',
        trust: 'unchecked',
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
  const resolveAgentEnvironment = options.resolveAgentEnvironment ?? getAgentEnvironmentStrict;
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
    ...(options.renameProviderSkillPath
      ? { renameProviderSkillPath: options.renameProviderSkillPath }
      : {}),
  });

  const resolveEnvironment = async (
    request: ProviderIntegrationLaunchRequest,
  ): Promise<AgentEnvironment> => {
    try {
      return request.agentEnvironmentOwner.kind === 'user'
        ? await resolveAgentEnvironment(request.agentEnvironmentOwner.userId)
        : await resolveDefaultEnvironment();
    } catch (error) {
      throw new ProviderIntegrationEnvironmentError(error);
    }
  };

  const notApplicableDecision = (
    agentEnvironment: AgentEnvironment,
    requirements: ProviderIntegrationRequirements,
  ): ProviderIntegrationLaunchDecision => ({
    providerHome: { owner: 'agent-environment', agentEnvironment },
    lifecycle: resolveArtifactPolicy(requirements.lifecycle),
    skill: resolveArtifactPolicy(requirements.skill),
    health: { state: 'healthy' },
  });

  const lifecycleDecision = (
    agentEnvironment: AgentEnvironment,
    requirements: ProviderIntegrationRequirements,
    result: ProviderLifecycleResult,
    consent: ProviderIntegrationConsentState,
  ): ProviderIntegrationLaunchDecision => ({
    providerHome: { owner: 'agent-environment', agentEnvironment },
    lifecycle: {
      requirement: requirements.lifecycle,
      state: result.state,
      consent,
      trust: result.trust,
      ...(result.message ? { message: result.message } : {}),
    },
    skill: resolveArtifactPolicy(requirements.skill),
    health: {
      state: result.state === 'installed' && result.trust === 'trusted'
        ? 'healthy'
        : 'blocked',
    },
    ...(result.guidance ? { guidance: result.guidance } : {}),
  });

  return {
    manageSkills: (request) => skillManager.manage(request),
    async resolveLaunch(request) {
      const agentEnvironment = await resolveEnvironment(request);
      const requirements = request.provider.getProviderIntegrationRequirements?.()
        ?? DEFAULT_REQUIREMENTS;
      const lifecycle = resolveArtifactPolicy(requirements.lifecycle);
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
            trust: 'not-required',
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
            trust: 'not-required',
          };
          health = { state: 'degraded' };
        }
      }
      if (
        lifecycle.requirement === 'required'
        && lifecycle.state === 'unchecked'
        && health.state === 'healthy'
      ) {
        health = { state: 'unchecked' };
      }
      return {
        providerHome: {
          owner: 'agent-environment',
          agentEnvironment,
        },
        lifecycle,
        skill,
        health,
      };
    },
    async inspectLifecycle(request) {
      const agentEnvironment = await resolveEnvironment(request);
      const requirements = request.provider.getProviderIntegrationRequirements?.()
        ?? DEFAULT_REQUIREMENTS;
      if (requirements.lifecycle === 'not-applicable') {
        return notApplicableDecision(agentEnvironment, requirements);
      }
      const lifecycle = options.lifecycle ?? request.provider.getLifecycleIntegration?.();
      const result = lifecycle
        ? await lifecycle.inspect({
            environment: agentEnvironment,
            userId: request.agentEnvironmentOwner.kind === 'user'
              ? request.agentEnvironmentOwner.userId
              : undefined,
            workDir: request.workDir,
          })
        : {
            state: 'unavailable' as const,
            trust: 'unavailable' as const,
            message: 'The provider does not expose required lifecycle management.',
          };
      return lifecycleDecision(
        agentEnvironment,
        requirements,
        result,
        result.state === 'installed' ? 'granted' : 'required',
      );
    },
    async installLifecycle(request) {
      const agentEnvironment = await resolveEnvironment(request);
      const requirements = request.provider.getProviderIntegrationRequirements?.()
        ?? DEFAULT_REQUIREMENTS;
      if (requirements.lifecycle === 'not-applicable') {
        return notApplicableDecision(agentEnvironment, requirements);
      }
      const lifecycle = options.lifecycle ?? request.provider.getLifecycleIntegration?.();
      if (!lifecycle) {
        return lifecycleDecision(agentEnvironment, requirements, {
          state: 'unavailable',
          trust: 'unavailable',
          message: 'The provider does not expose required lifecycle management.',
        }, request.consent);
      }
      const context = {
        environment: agentEnvironment,
        userId: request.agentEnvironmentOwner.kind === 'user'
          ? request.agentEnvironmentOwner.userId
          : undefined,
        workDir: request.workDir,
      };
      if (request.consent === 'declined') {
        const result = await lifecycle.inspect(context);
        return lifecycleDecision(agentEnvironment, requirements, result, 'declined');
      }
      const result = await lifecycle.install(context);
      return lifecycleDecision(agentEnvironment, requirements, result, 'granted');
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
