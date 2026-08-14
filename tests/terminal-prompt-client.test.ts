import assert from 'node:assert/strict';
import test from 'node:test';

import { WebSocketClient } from '@/lib/ws/client';
import type { TerminalPromptSubmitResult } from '@/lib/ws/client-message-handlers';
import type { ServerTransportMessage } from '@/lib/ws/message-types';

type ClientInternals = {
  terminalPromptCallbacks: Map<string, (result: TerminalPromptSubmitResult) => void>;
  failPendingRequestCallbacks: () => void;
  handleMessage: (message: ServerTransportMessage) => void;
};

test('terminal prompt registers correlation before sending and resolves from acceptance', async () => {
  const client = new WebSocketClient();
  const sent: string[] = [];
  Reflect.set(client, 'ws', {
    readyState: WebSocket.OPEN,
    send: (payload: string) => sent.push(payload),
  });

  const resultPromise = client.submitTerminalPrompt('session-a', 'hello', 'submission-a');
  const request = JSON.parse(sent[0]) as {
    type: string;
    requestId: string;
    sessionId: string;
    text: string;
    submissionId: string;
  };
  const internals = client as unknown as ClientInternals;
  assert.equal(request.type, 'terminal_prompt');
  assert.equal(request.sessionId, 'session-a');
  assert.equal(request.text, 'hello');
  assert.equal(request.submissionId, 'submission-a');
  assert.equal(internals.terminalPromptCallbacks.has(request.requestId), true);

  internals.handleMessage({
    type: 'terminal_prompt_accepted',
    requestId: request.requestId,
    sessionId: 'session-a',
  });
  assert.deepEqual(await resultPromise, { accepted: true });
  assert.equal(internals.terminalPromptCallbacks.size, 0);
});

test('terminal prompt pending requests fail closed on WebSocket disconnect', async () => {
  const client = new WebSocketClient();
  Reflect.set(client, 'ws', {
    readyState: WebSocket.OPEN,
    send: () => undefined,
  });
  const internals = client as unknown as ClientInternals;

  const resultPromise = client.submitTerminalPrompt('session-a', 'hello', 'submission-a');
  internals.failPendingRequestCallbacks();

  assert.deepEqual(await resultPromise, { accepted: false, reason: 'connection' });
  assert.equal(internals.terminalPromptCallbacks.size, 0);
});
