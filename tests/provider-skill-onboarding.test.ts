import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createProviderSkillOnboarding,
  startProviderSessionWithOptionalSkill,
} from '@/lib/cli/provider-skill-onboarding';
import {
  getProviderSkillActions,
  shouldOfferProviderSkillOnboarding,
} from '@/lib/cli/provider-skill-view-policy';
import type {
  ProviderSkillManagementResult,
  ProviderSkillStatus,
} from '@/lib/cli/provider-skill-management';

function status(overrides: Partial<ProviderSkillStatus> = {}): ProviderSkillStatus {
  return {
    providerId: 'codex',
    detected: true,
    state: 'absent',
    consent: 'not-granted',
    ownership: 'none',
    ...overrides,
  };
}

function snapshot(
  agentEnvironment: 'native' | 'wsl',
  providerStatus: ProviderSkillStatus,
): ProviderSkillManagementResult {
  return {
    success: true,
    operation: 'status',
    agentEnvironment,
    providers: [providerStatus],
  };
}

test('only a newly detected absent provider with no prior consent gets onboarding', () => {
  assert.equal(shouldOfferProviderSkillOnboarding(status()), true);
  assert.equal(shouldOfferProviderSkillOnboarding(status({ detected: false })), false);
  assert.equal(shouldOfferProviderSkillOnboarding(status({ consent: 'revoked' })), false);
  assert.equal(shouldOfferProviderSkillOnboarding(status({ state: 'conflict', ownership: 'user' })), false);
  assert.equal(shouldOfferProviderSkillOnboarding(status({ state: 'ready', consent: 'granted', ownership: 'tessera' })), false);
});

test('skill actions preserve consent, ownership, and conflict policy', () => {
  assert.deepEqual(getProviderSkillActions(status()), {
    canInstall: true,
    canUpdate: false,
    canRemove: false,
  });
  assert.deepEqual(getProviderSkillActions(status({ detected: false })), {
    canInstall: false,
    canUpdate: false,
    canRemove: false,
  });
  assert.deepEqual(getProviderSkillActions(status({ state: 'ready', ownership: 'tessera' })), {
    canInstall: false,
    canUpdate: false,
    canRemove: false,
  });
  assert.deepEqual(getProviderSkillActions(status({ consent: 'revoked' })), {
    canInstall: true,
    canUpdate: false,
    canRemove: false,
  });
  assert.deepEqual(getProviderSkillActions(status({ state: 'stale', consent: 'granted', ownership: 'tessera' })), {
    canInstall: false,
    canUpdate: true,
    canRemove: true,
  });
  assert.deepEqual(getProviderSkillActions(status({ state: 'conflict', consent: 'granted', ownership: 'tessera' })), {
    canInstall: false,
    canUpdate: false,
    canRemove: false,
  });
});

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
  const onboarding = createProviderSkillOnboarding({
    readStatus: async (providerId) => snapshot(environment, status({ providerId })),
    install: async (providerId) => {
      installs.push({ providerId, environment });
      return snapshot(environment, status({
        providerId,
        state: 'ready',
        consent: 'granted',
        ownership: 'tessera',
      }));
    },
    showOffer: (offer) => {
      offers.push(`${offer.agentEnvironment}:${offer.providerId}`);
      if (offer.providerId === 'codex' && offer.agentEnvironment === 'wsl') {
        void offer.install();
      }
    },
  });

  assert.equal(await onboarding.offer('codex'), 'offered');
  assert.equal(await onboarding.offer('codex'), 'already-offered');
  assert.equal(await onboarding.offer('opencode'), 'offered');
  environment = 'wsl';
  assert.equal(await onboarding.offer('codex'), 'offered');
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(offers, ['native:codex', 'native:opencode', 'wsl:codex']);
  assert.deepEqual(installs, [{ providerId: 'codex', environment: 'wsl' }]);
});
