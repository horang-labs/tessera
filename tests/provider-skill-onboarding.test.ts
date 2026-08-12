import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createProviderSkillOnboarding,
  startProviderSessionWithOptionalSkill,
} from '@/lib/cli/provider-skill-onboarding';
import type {
  ProviderSkillIntegrationResult,
  ProviderSkillIntegrationStatus,
} from '@/lib/cli/provider-integration';

function status(
  overrides: Partial<Omit<ProviderSkillIntegrationStatus, 'policy'>> = {},
  onboarding: ProviderSkillIntegrationStatus['policy']['onboarding'] = 'offer',
): ProviderSkillIntegrationStatus {
  const providerStatus = {
    providerId: 'codex',
    detected: true,
    state: 'absent',
    consent: 'not-granted',
    ownership: 'none',
    ...overrides,
  } as const;
  return {
    ...providerStatus,
    policy: {
      onboarding,
      canInstall: onboarding === 'offer',
      canUpdate: false,
      canRemove: false,
    },
  };
}

function snapshot(
  agentEnvironment: 'native' | 'wsl',
  providerStatus: ProviderSkillIntegrationStatus,
): ProviderSkillIntegrationResult {
  return {
    success: true,
    operation: 'status',
    agentEnvironment,
    providers: [providerStatus],
  };
}

test('Session start returns without waiting for optional skill onboarding', async () => {
  let resolveOnboarding!: () => void;
  const onboarding = new Promise<void>((resolve) => {
    resolveOnboarding = resolve;
  });
  let started = false;

  const result = startProviderSessionWithOptionalSkill(
    'codex',
    () => {
      started = true;
      return 'session-started';
    },
    async () => onboarding,
  );

  assert.equal(started, true);
  assert.equal(result, 'session-started');
  resolveOnboarding();
  await onboarding;
});

test('onboarding offers each provider and Agent Environment independently', async () => {
  let environment: 'native' | 'wsl' = 'native';
  const offers: string[] = [];
  const installs: Array<{ providerId: string; environment: 'native' | 'wsl' }> = [];
  let installNativeOffer: (() => Promise<ProviderSkillIntegrationResult>) | undefined;
  const onboarding = createProviderSkillOnboarding({
    readStatus: async (providerId) => snapshot(environment, status({ providerId })),
    install: async (providerId, expectedAgentEnvironment) => {
      installs.push({ providerId, environment: expectedAgentEnvironment });
      return snapshot(expectedAgentEnvironment, status({
        providerId,
        state: 'ready',
        consent: 'granted',
        ownership: 'tessera',
      }, 'none'));
    },
    showOffer: (offer) => {
      offers.push(`${offer.agentEnvironment}:${offer.providerId}`);
      if (offer.providerId === 'codex' && offer.agentEnvironment === 'native') {
        installNativeOffer = offer.install;
      }
      if (offer.providerId === 'codex' && offer.agentEnvironment === 'wsl') {
        void offer.install();
      }
    },
  });

  assert.equal(await onboarding.offer('codex'), 'offered');
  assert.equal(await onboarding.offer('codex'), 'already-offered');
  assert.equal(await onboarding.offer('opencode'), 'offered');
  environment = 'wsl';
  await installNativeOffer?.();
  assert.equal(await onboarding.offer('codex'), 'offered');
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(offers, ['native:codex', 'native:opencode', 'wsl:codex']);
  assert.deepEqual(installs, [
    { providerId: 'codex', environment: 'native' },
    { providerId: 'codex', environment: 'wsl' },
  ]);
});

test('onboarding obeys the Provider Integration decision instead of re-deriving policy', async () => {
  const onboarding = createProviderSkillOnboarding({
    readStatus: async () => snapshot('wsl', status({}, 'none')),
    install: async () => {
      throw new Error('must not install');
    },
    showOffer: () => assert.fail('must not offer'),
  });

  assert.equal(await onboarding.offer('codex'), 'not-needed');
});
