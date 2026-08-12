import assert from 'node:assert/strict';
import test from 'node:test';
import { ProviderIntegrationLaunchBlockedError } from '@/lib/cli/provider-integration';
import { ProviderLaunchError } from '@/lib/terminal/provider-launch-module';
import { buildProviderIntegrationBlockMessage } from '@/lib/ws/provider-integration-recovery-message';

test('Codex preflight failures become structured recovery outside terminal output', () => {
  const blocked = new ProviderIntegrationLaunchBlockedError({
    providerHome: { owner: 'agent-environment', agentEnvironment: 'wsl' },
    lifecycle: {
      requirement: 'required', state: 'unavailable', consent: 'required', trust: 'unavailable',
      message: 'Codex hook trust API is unavailable.',
    },
    skill: { requirement: 'optional', state: 'unchecked', consent: 'unchecked', trust: 'not-required' },
    health: { state: 'blocked' },
    guidance: { minimumVersion: '0.146.0', updateCommand: 'npm install -g @openai/codex@latest', message: 'Update Codex.' },
  }, 'raw launch wrapper detail');
  const wrapped = new ProviderLaunchError(
    'LAUNCH_FAILED',
    'raw launch wrapper detail',
    'terminal-1',
    { cause: blocked },
  );

  const message = buildProviderIntegrationBlockMessage(wrapped, {
    terminalId: 'terminal-1', surfaceId: 'surface-1', providerId: 'codex',
  });

  assert.deepEqual(message, {
    type: 'provider_integration_launch_blocked',
    terminalId: 'terminal-1',
    surfaceId: 'surface-1',
    providerId: 'codex',
    reason: 'unsupported',
    title: 'Codex setup needs attention',
    message: 'Codex hook trust API is unavailable.',
    retryLabel: 'Retry setup',
    updateCommand: 'npm install -g @openai/codex@latest',
  });
  assert.doesNotMatch(JSON.stringify(message), /raw launch wrapper detail/);
});

test('app-server Codex preflight failures target the Session recovery surface', () => {
  const blocked = new ProviderIntegrationLaunchBlockedError({
    providerHome: { owner: 'agent-environment', agentEnvironment: 'wsl' },
    lifecycle: {
      requirement: 'required', state: 'conflict', consent: 'granted', trust: 'untrusted',
      message: 'The managed hook differs.',
    },
    skill: { requirement: 'optional', state: 'unchecked', consent: 'unchecked', trust: 'not-required' },
    health: { state: 'blocked' },
  }, 'raw app-server detail');

  assert.deepEqual(buildProviderIntegrationBlockMessage(blocked, {
    sessionId: 'session-1', providerId: 'codex',
  }), {
    type: 'provider_integration_launch_blocked',
    sessionId: 'session-1',
    providerId: 'codex',
    reason: 'conflict',
    title: 'Codex setup needs attention',
    message: 'The managed hook differs.',
    retryLabel: 'Retry setup',
  });
});
