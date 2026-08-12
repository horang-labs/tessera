import { i18n } from '@/lib/i18n';
import { useNotificationStore } from '@/stores/notification-store';
import type {
  ProviderSkillId,
  ProviderSkillManagementResult,
} from './provider-skill-management';
import {
  PROVIDER_SKILL_DISPLAY_NAMES,
  shouldOfferProviderSkillOnboarding,
} from './provider-skill-view-policy';

const ENDPOINT = '/api/provider-integrations/skills';

export interface ProviderSkillOnboardingOffer {
  providerId: ProviderSkillId;
  agentEnvironment: ProviderSkillManagementResult['agentEnvironment'];
  install(): Promise<ProviderSkillManagementResult>;
}

interface ProviderSkillOnboardingOptions {
  readStatus(providerId: ProviderSkillId): Promise<ProviderSkillManagementResult>;
  install(providerId: ProviderSkillId): Promise<ProviderSkillManagementResult>;
  showOffer(offer: ProviderSkillOnboardingOffer): void;
}

export interface ProviderSkillOnboarding {
  offer(providerId: string): Promise<ProviderSkillOnboardingOutcome>;
}

type ProviderSkillOnboardingOutcome = 'offered' | 'already-offered' | 'not-needed' | 'unavailable';

async function readResult(response: Response): Promise<ProviderSkillManagementResult> {
  const result = await response.json() as ProviderSkillManagementResult | { error?: unknown };
  if (!response.ok) {
    throw new Error(
      typeof (result as { error?: unknown }).error === 'string'
        ? (result as { error: string }).error
        : `Provider skill request failed (${response.status}).`,
    );
  }
  return result as ProviderSkillManagementResult;
}

function providerSkillId(providerId: string): ProviderSkillId | null {
  return providerId === 'claude-code' || providerId === 'codex' || providerId === 'opencode'
    ? providerId
    : null;
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
          if (!status || !shouldOfferProviderSkillOnboarding(status)) return 'not-needed' as const;
          const scope = `${result.agentEnvironment}:${normalizedProviderId}`;
          if (offeredScopes.has(scope)) return 'already-offered' as const;
          offeredScopes.add(scope);
          options.showOffer({
            providerId: normalizedProviderId,
            agentEnvironment: result.agentEnvironment,
            install: () => options.install(normalizedProviderId),
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
  readStatus: async (providerId) => readResult(await fetch(
    `${ENDPOINT}?provider=${encodeURIComponent(providerId)}`,
    { cache: 'no-store' },
  )),
  install: async (providerId) => {
    const result = await readResult(await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ operation: 'install', providerIds: [providerId] }),
    }));
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

export function offerProviderSkillOnboarding(providerId: string): void {
  void providerSkillOnboarding.offer(providerId).catch(() => undefined);
}

export function startProviderSessionWithOptionalSkill<T>(
  providerId: string,
  start: () => T,
  offer: (providerId: string) => Promise<unknown> = (id) => providerSkillOnboarding.offer(id),
): T {
  const result = start();
  void offer(providerId).catch(() => undefined);
  return result;
}
