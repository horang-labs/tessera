import type { AgentEnvironment } from '@/lib/settings/types';
import { getAgentEnvironment } from './spawn-cli';

export type ProviderIntegrationLaunchSurface = 'app-server' | 'direct-tui';

export type ProviderIntegrationArtifactState =
  | 'unchecked'
  | 'ready'
  | 'absent'
  | 'conflict';

export type ProviderIntegrationConsentState =
  | 'unchecked'
  | 'not-required'
  | 'granted'
  | 'declined';

export interface ProviderIntegrationArtifactPolicy {
  requirement: 'required' | 'optional';
  state: ProviderIntegrationArtifactState;
  consent: ProviderIntegrationConsentState;
}

export interface ProviderIntegrationHealth {
  state: 'unchecked' | 'healthy' | 'degraded' | 'blocked';
}

export interface ProviderIntegrationLaunchDecision {
  providerId: string;
  surface: ProviderIntegrationLaunchSurface;
  agentEnvironment: AgentEnvironment;
  providerHome: {
    owner: 'agent-environment';
    mode: 'inherited' | 'session-overlay';
  };
  lifecycle: ProviderIntegrationArtifactPolicy;
  skill: ProviderIntegrationArtifactPolicy;
  health: ProviderIntegrationHealth;
}

export interface ProviderIntegrationLaunchRequest {
  providerId: string;
  surface: ProviderIntegrationLaunchSurface;
  userId?: string;
}

export interface ProviderIntegration {
  resolveLaunch(
    request: ProviderIntegrationLaunchRequest,
  ): Promise<ProviderIntegrationLaunchDecision>;
}

interface ProviderIntegrationOptions {
  resolveAgentEnvironment?: (userId?: string) => Promise<AgentEnvironment>;
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

  return {
    async resolveLaunch(request) {
      const agentEnvironment = await resolveAgentEnvironment(request.userId);
      return {
        providerId: request.providerId,
        surface: request.surface,
        agentEnvironment,
        providerHome: {
          owner: 'agent-environment',
          mode: request.providerId === 'codex' && request.surface === 'direct-tui'
            ? 'session-overlay'
            : 'inherited',
        },
        lifecycle: {
          requirement: 'required',
          state: 'unchecked',
          consent: 'unchecked',
        },
        skill: {
          requirement: 'optional',
          state: 'unchecked',
          consent: 'unchecked',
        },
        health: { state: 'unchecked' },
      };
    },
  };
}

export const providerIntegration = createProviderIntegration();
