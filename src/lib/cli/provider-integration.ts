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

export type ProviderIntegrationArtifactState =
  | 'unchecked'
  | 'ready'
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
  compatibility?: 'exact-legacy-overlay-resume';
}

export interface ProviderIntegrationLaunchRequest {
  provider: Pick<
    CliProvider,
    | 'getProviderId'
    | 'getProviderIntegrationRequirements'
    | 'getLifecycleIntegration'
  >;
  agentEnvironmentOwner:
    | { kind: 'user'; userId: string }
    | { kind: 'server-default' };
  workDir?: string | null;
  compatibility?: 'exact-legacy-overlay-resume';
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
}

interface ProviderIntegrationOptions {
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

export class ProviderIntegrationLaunchBlockedError extends Error {
  constructor(readonly decision: ProviderIntegrationLaunchDecision, message: string) {
    super(message);
    this.name = 'ProviderIntegrationLaunchBlockedError';
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

function launchBlockedMessage(
  providerId: string,
  decision: ProviderIntegrationLaunchDecision,
): string {
  const displayName = providerId === 'codex' ? 'Codex' : providerId;
  const lifecycle = decision.lifecycle;
  if (lifecycle.state === 'absent') {
    return `${displayName} launch is blocked because the required Tessera lifecycle hook is not installed in the Authoritative Provider Home. Run \`tessera provider ${providerId} lifecycle install --consent\` and retry.`;
  }
  if (lifecycle.state === 'installed' && lifecycle.trust !== 'trusted') {
    return `${displayName} launch is blocked because the required Tessera lifecycle hook is not trusted. Run \`tessera provider ${providerId} lifecycle install --consent\` and retry.${lifecycle.message ? ` ${lifecycle.message}` : ''}`;
  }
  return `${displayName} launch is blocked because the required Tessera lifecycle hook is unavailable or unhealthy. Run \`tessera provider ${providerId} lifecycle status\` and follow its guidance before retrying.${lifecycle.message ? ` ${lifecycle.message}` : ''}`;
}

/**
 * Shared policy boundary for provider launches.
 *
 * Callers receive domain decisions only. Provider homes and launch environment
 * values remain behind each provider adapter so this contract stays path-free.
 */
export function createProviderIntegration(
  options: ProviderIntegrationOptions = {},
): ProviderIntegration {
  const resolveAgentEnvironment = options.resolveAgentEnvironment ?? getAgentEnvironmentStrict;
  const resolveDefaultEnvironment = options.resolveDefaultEnvironment
    ?? (async () => resolveDefaultAgentEnvironment());

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
    async resolveLaunch(request) {
      const agentEnvironment = await resolveEnvironment(request);
      const requirements = request.provider.getProviderIntegrationRequirements?.()
        ?? DEFAULT_REQUIREMENTS;
      if (
        request.provider.getProviderId() === 'codex'
        && request.compatibility === 'exact-legacy-overlay-resume'
      ) {
        return {
          providerHome: {
            owner: 'agent-environment',
            agentEnvironment,
          },
          lifecycle: resolveArtifactPolicy(requirements.lifecycle),
          skill: resolveArtifactPolicy(requirements.skill),
          health: { state: 'healthy' },
          compatibility: request.compatibility,
        };
      }

      let decision: ProviderIntegrationLaunchDecision = {
        providerHome: {
          owner: 'agent-environment',
          agentEnvironment,
        },
        lifecycle: resolveArtifactPolicy(requirements.lifecycle),
        skill: resolveArtifactPolicy(requirements.skill),
        health: { state: 'unchecked' },
      };
      if (requirements.lifecycle === 'required') {
        const lifecycle = options.lifecycle ?? request.provider.getLifecycleIntegration?.();
        let result: ProviderLifecycleResult;
        try {
          result = lifecycle
            ? await lifecycle.inspect({
                environment: agentEnvironment,
                userId: request.agentEnvironmentOwner.kind === 'user'
                  ? request.agentEnvironmentOwner.userId
                  : undefined,
                workDir: request.workDir,
              })
            : {
                state: 'unavailable',
                trust: 'unavailable',
                message: 'The provider does not expose required lifecycle management.',
              };
        } catch (error) {
          result = {
            state: 'unavailable',
            trust: 'unavailable',
            message: `Lifecycle status could not be inspected: ${error instanceof Error ? error.message : String(error)}`,
          };
        }
        decision = lifecycleDecision(
          agentEnvironment,
          requirements,
          result,
          result.state === 'installed' ? 'granted' : 'required',
        );
        if (decision.health.state !== 'healthy') {
          throw new ProviderIntegrationLaunchBlockedError(
            decision,
            launchBlockedMessage(request.provider.getProviderId(), decision),
          );
        }
      }

      return decision;
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

export const providerIntegration = createProviderIntegration();
