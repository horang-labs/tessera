import assert from 'node:assert/strict';
import test from 'node:test';
import { getCodexLifecycleActions } from '@/lib/cli/codex-lifecycle-view-policy';
import type { ProviderIntegrationLaunchDecision } from '@/lib/cli/provider-integration';

function decision(
  consent: ProviderIntegrationLaunchDecision['lifecycle']['consent'],
  state: ProviderIntegrationLaunchDecision['lifecycle']['state'],
): ProviderIntegrationLaunchDecision {
  return {
    providerHome: { owner: 'agent-environment', agentEnvironment: 'native' },
    lifecycle: { requirement: 'required', state, consent, trust: 'unchecked' },
    skill: {
      requirement: 'optional', state: 'unchecked', consent: 'unchecked', trust: 'unchecked',
    },
    health: { state: consent === 'granted' ? 'degraded' : 'blocked' },
  };
}

test('GUI keeps update and removal available after consent even when the hook is absent', () => {
  assert.deepEqual(getCodexLifecycleActions(decision('granted', 'absent')), {
    canInstall: false,
    canUpdate: true,
    canRemove: true,
  });
  assert.deepEqual(getCodexLifecycleActions(decision('required', 'absent')), {
    canInstall: true,
    canUpdate: false,
    canRemove: false,
  });
});
