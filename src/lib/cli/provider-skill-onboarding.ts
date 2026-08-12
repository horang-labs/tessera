import { isProviderSkillId, type ProviderSkillId } from './provider-skill-id';
import type { ProviderSkillIntegrationResult } from './provider-integration';
import { PROVIDER_SKILL_DISPLAY_NAMES } from './provider-skill-view-policy';
import { inspectTesseraCliSkill } from './tessera-cli-skill-client';
import { useProviderSkillOnboardingStore } from '@/stores/provider-skill-onboarding-store';

export interface ProviderSkillOnboardingOffer {
  providerId: ProviderSkillId;
  agentEnvironment: ProviderSkillIntegrationResult['agentEnvironment'];
  install(): Promise<ProviderSkillIntegrationResult>;
}

interface ProviderSkillOnboardingOptions {
  readStatus(providerId: ProviderSkillId): Promise<ProviderSkillIntegrationResult>;
  install(
    providerId: ProviderSkillId,
    expectedAgentEnvironment: ProviderSkillIntegrationResult['agentEnvironment'],
  ): Promise<ProviderSkillIntegrationResult>;
  showOffer(offer: ProviderSkillOnboardingOffer): void;
}

export interface ProviderSkillOnboarding {
  offer(providerId: string): Promise<ProviderSkillOnboardingOutcome>;
}

type ProviderSkillOnboardingOutcome = 'offered' | 'already-offered' | 'not-needed' | 'unavailable';

function providerSkillId(providerId: string): ProviderSkillId | null {
  return isProviderSkillId(providerId) ? providerId : null;
}

export function createProviderSkillOnboarding(
  options: ProviderSkillOnboardingOptions,
): ProviderSkillOnboarding {
  const offeredScopes = new Set<string>();
  const pendingProviders = new Map<ProviderSkillId, Promise<ProviderSkillOnboardingOutcome>>();

  return {
    async offer(rawProviderId) {
      const normalizedProviderId = providerSkillId(rawProviderId);
      if (!normalizedProviderId) return 'not-needed';
      const pending = pendingProviders.get(normalizedProviderId);
      if (pending) return pending;

      const operation = (async () => {
        try {
          const result = await options.readStatus(normalizedProviderId);
          const status = result.providers.find(({ providerId }) => providerId === normalizedProviderId);
          if (!status || status.policy.onboarding !== 'offer') return 'not-needed' as const;
          const scope = `${result.agentEnvironment}:${normalizedProviderId}`;
          if (offeredScopes.has(scope)) return 'already-offered' as const;
          offeredScopes.add(scope);
          options.showOffer({
            providerId: normalizedProviderId,
            agentEnvironment: result.agentEnvironment,
            install: () => options.install(normalizedProviderId, result.agentEnvironment),
          });
          return 'offered' as const;
        } catch {
          return 'unavailable' as const;
        } finally {
          pendingProviders.delete(normalizedProviderId);
        }
      })();
      pendingProviders.set(normalizedProviderId, operation);
      return operation;
    },
  };
}

const offeredStandardSkillScopes = new Set<string>();
const providerSkillOnboarding: ProviderSkillOnboarding = {
  async offer(providerId) {
    const normalizedProviderId = providerSkillId(providerId);
    if (!normalizedProviderId) return 'not-needed';
    try {
      const status = await inspectTesseraCliSkill();
      if (status.state === 'installed' && status.agents.includes(PROVIDER_SKILL_DISPLAY_NAMES[normalizedProviderId])) {
        return 'not-needed';
      }
      const scope = `${status.agentEnvironment}:${normalizedProviderId}`;
      if (offeredStandardSkillScopes.has(scope)) return 'already-offered';
      offeredStandardSkillScopes.add(scope);
      const provider = PROVIDER_SKILL_DISPLAY_NAMES[normalizedProviderId];
      useProviderSkillOnboardingStore.getState().open(provider, status.agentEnvironment);
      return 'offered';
    } catch {
      return 'unavailable';
    }
  },
};

export function notifyProviderSessionStarted(
  providerId: string,
  wasAlreadyStarted: boolean,
  startSucceeded = true,
  offer: (providerId: string) => Promise<unknown> = (id) => providerSkillOnboarding.offer(id),
): void {
  if (wasAlreadyStarted || !startSucceeded) return;
  void offer(providerId).catch(() => undefined);
}
