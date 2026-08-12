import assert from 'node:assert/strict';
import test, { beforeEach } from 'node:test';
import { handleIncomingServerMessage } from '@/lib/ws/client-message-handlers';
import { useChatStore } from '@/stores/chat-store';

const SESSION_ID = 'cli-down-session';

function presentCliDown(providerName: string): string {
  handleIncomingServerMessage({
    msg: {
      type: 'cli_down',
      sessionId: SESSION_ID,
      exitCode: -1,
      message: `${providerName} process exited`,
      providerName,
    },
    providersListCallbacks: new Map(),
    cliStatusCallbacks: new Map(),
    wasReconnect: false,
  });

  const messages = useChatStore.getState().messages.get(SESSION_ID) ?? [];
  const content = messages.at(-1)?.content;
  assert.equal(typeof content, 'string');
  return content;
}

beforeEach(() => {
  useChatStore.setState(useChatStore.getInitialState(), true);
});

test('Codex cli_down is presented with the Codex provider label', () => {
  assert.equal(
    presentCliDown('Codex'),
    'Codex stopped (exit code: -1): Codex process exited',
  );
});

test('Claude Code cli_down is presented with the Claude Code provider label', () => {
  assert.equal(
    presentCliDown('Claude Code'),
    'Claude Code stopped (exit code: -1): Claude Code process exited',
  );
});

test('OpenCode cli_down is presented with the OpenCode provider label', () => {
  assert.equal(
    presentCliDown('OpenCode'),
    'OpenCode stopped (exit code: -1): OpenCode process exited',
  );
});
