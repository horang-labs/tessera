import assert from 'node:assert/strict';
import test from 'node:test';
import { OpenCodeProtocolParser } from '@/lib/cli/providers/opencode/protocol-parser';

function receiveCommands(availableCommands: unknown[]) {
  return new OpenCodeProtocolParser().parseStdout('catalog-test', JSON.stringify({
    jsonrpc: '2.0',
    method: 'session/update',
    params: {
      sessionId: 'opencode-session',
      update: { sessionUpdate: 'available_commands_update', availableCommands },
    },
  }));
}

for (const catalog of [[], [{ name: 'review', description: 'Review code' }]]) {
  test(`ACP catalog with ${catalog.length} commands gains compact in both storage and UI delivery`, () => {
    const messages = receiveCommands(catalog);
    const stored = messages.find((message) => message.sideEffect?.type === 'store_commands')?.sideEffect;
    const delivered = messages.find((message) => message.serverMessage?.type === 'commands_ready')?.serverMessage;
    assert.equal(stored?.type, 'store_commands');
    assert.equal(delivered?.type, 'commands_ready');
    if (stored?.type !== 'store_commands' || delivered?.type !== 'commands_ready') return;
    const expected = [...catalog, { name: 'compact', description: 'compact the session' }];
    assert.deepEqual(stored.commands, expected);
    assert.deepEqual(delivered.commands, expected);
  });
}

test('ACP provider-reported compact retains its description and is not duplicated', () => {
  const catalog = [{ name: 'compact', description: 'Provider description' }];
  const delivered = receiveCommands(catalog).find((message) => message.serverMessage?.type === 'commands_ready')?.serverMessage;
  assert.equal(delivered?.type, 'commands_ready');
  if (delivered?.type === 'commands_ready') assert.deepEqual(delivered.commands, catalog);
});
