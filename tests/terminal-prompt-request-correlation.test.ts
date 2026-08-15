import assert from 'node:assert/strict';
import test from 'node:test';

import {
  handleIncomingServerMessage,
  type TerminalPromptSubmitResult,
} from '@/lib/ws/client-message-handlers';

test('terminal prompt settles only from its matching acceptance', () => {
  let result: TerminalPromptSubmitResult | null = null;
  const terminalPromptCallbacks = new Map([
    ['prompt-request', (value: TerminalPromptSubmitResult) => { result = value; }],
  ]);

  handleIncomingServerMessage({
    msg: {
      type: 'terminal_prompt_accepted',
      requestId: 'another-request',
      sessionId: 'session-a',
    },
    providersListCallbacks: new Map(),
    cliStatusCallbacks: new Map(),
    terminalPromptCallbacks,
    wasReconnect: false,
  });
  assert.equal(result, null);
  assert.equal(terminalPromptCallbacks.size, 1);

  handleIncomingServerMessage({
    msg: {
      type: 'terminal_prompt_accepted',
      requestId: 'prompt-request',
      sessionId: 'session-a',
    },
    providersListCallbacks: new Map(),
    cliStatusCallbacks: new Map(),
    terminalPromptCallbacks,
    wasReconnect: false,
  });
  assert.deepEqual(result, { accepted: true });
  assert.equal(terminalPromptCallbacks.size, 0);
});

test('terminal prompt surfaces its matching server rejection without waiting for timeout', () => {
  let result: TerminalPromptSubmitResult | null = null;
  const terminalPromptCallbacks = new Map([
    ['prompt-request', (value: TerminalPromptSubmitResult) => { result = value; }],
  ]);

  handleIncomingServerMessage({
    msg: {
      type: 'error',
      requestId: 'prompt-request',
      sessionId: 'session-a',
      code: 'terminal_input_not_accepted',
      message: 'The terminal did not accept Enter.',
    },
    providersListCallbacks: new Map(),
    cliStatusCallbacks: new Map(),
    terminalPromptCallbacks,
    wasReconnect: false,
  });

  assert.deepEqual(result, {
    accepted: false,
    reason: 'server',
    message: 'The terminal did not accept Enter.',
  });
  assert.equal(terminalPromptCallbacks.size, 0);
});
