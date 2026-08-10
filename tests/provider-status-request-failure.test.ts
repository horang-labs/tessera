import assert from 'node:assert/strict';
import test from 'node:test';
import { handleIncomingServerMessage } from '@/lib/ws/client-message-handlers';
import type { CliStatusEntry } from '@/lib/cli/connection-checker';
import type { ProviderMeta } from '@/lib/cli/providers/types';

test('provider probe errors are distinct from WebSocket disconnection and an empty catalog', () => {
  let providersResult: ProviderMeta[] | null | 'unresolved' = 'unresolved';
  let cliStatusResult: CliStatusEntry[] | null | undefined | 'unresolved' = 'unresolved';
  const providersListCallbacks = new Map([
    ['provider-request', (providers: ProviderMeta[] | null) => { providersResult = providers; }],
  ]);
  const cliStatusCallbacks = new Map([
    [
      'cli-request',
      (results: CliStatusEntry[] | null | undefined) => { cliStatusResult = results; },
    ],
  ]);

  handleIncomingServerMessage({
    msg: {
      type: 'error',
      code: 'refresh_providers_failed',
      message: 'Failed to refresh providers',
      requestId: 'provider-request',
    },
    providersListCallbacks,
    cliStatusCallbacks,
    wasReconnect: false,
  });
  assert.equal(providersResult, null);

  handleIncomingServerMessage({
    msg: {
      type: 'error',
      code: 'check_cli_status_failed',
      message: 'Failed to check CLI status',
      requestId: 'cli-request',
    },
    providersListCallbacks,
    cliStatusCallbacks,
    wasReconnect: false,
  });
  assert.equal(cliStatusResult, undefined);
});
