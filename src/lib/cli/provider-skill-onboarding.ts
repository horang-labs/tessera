import { i18n } from '@/lib/i18n';
import { useNotificationStore } from '@/stores/notification-store';
import { isProviderSkillId, type ProviderSkillId } from './provider-skill-id';
import type { ProviderSkillIntegrationResult } from './provider-integration';
import { inspectProviderSkills, mutateProviderSkill } from './provider-skill-client';
import { PROVIDER_SKILL_DISPLAY_NAMES } from './provider-skill-view-policy';

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

const providerSkillOnboarding = createProviderSkillOnboarding({
  readStatus: async (providerId) => inspectProviderSkills({ providerId }),
  install: async (providerId, expectedAgentEnvironment) => {
    const result = await mutateProviderSkill({
      operation: 'install',
      providerId,
      expectedAgentEnvironment,
    });
    if (!result.success) throw new Error(result.error?.message ?? 'Provider skill installation failed.');
    return result;
  },
  showOffer: (offer) => {
    useNotificationStore.getState().showToastWithAction(
      i18n.t('settings.providerSkills.onboardingPrompt', {
        provider: PROVIDER_SKILL_DISPLAY_NAMES[offer.providerId],
        environment: offer.agentEnvironment === 'wsl' ? 'WSL' : 'Native',
      }),
      'info',
      {
        label: i18n.t('settings.providerSkills.install'),
        onClick: () => {
          void offer.install().then(
            () => useNotificationStore.getState().showToast(
              i18n.t('settings.providerSkills.installSuccess', {
                provider: PROVIDER_SKILL_DISPLAY_NAMES[offer.providerId],
              }),
              'success',
            ),
            () => useNotificationStore.getState().showToast(
              i18n.t('settings.providerSkills.installFailed', {
                provider: PROVIDER_SKILL_DISPLAY_NAMES[offer.providerId],
              }),
              'error',
            ),
          );
        },
      },
    );
  },
});

export function notifyProviderSessionStarted(
  providerId: string,
  wasAlreadyStarted: boolean,
  startSucceeded = true,
  offer: (providerId: string) => Promise<unknown> = (id) => providerSkillOnboarding.offer(id),
): void {
  if (wasAlreadyStarted || !startSucceeded) return;
  void offer(providerId).catch(() => undefined);
}
