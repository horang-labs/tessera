import assert from 'node:assert/strict';
import test from 'node:test';

import { WebSocketClient } from '@/lib/ws/client';
import { routeClientTransportMessage } from '@/lib/ws/server-message-routing';
import type { ClientMessage, ServerTransportMessage } from '@/lib/ws/message-types';

test('terminal chat client resolves only the matching server acknowledgement', async () => {
  const client = new WebSocketClient();
  const sent: ClientMessage[] = [];
  const internals = client as unknown as {
    ws: { readyState: number; send(data: string): void };
    handleMessage(message: ServerTransportMessage): void;
  };
  internals.ws = {
    readyState: WebSocket.OPEN,
    send: (data) => { sent.push(JSON.parse(data) as ClientMessage); },
  };

  const handle = client.submitTerminalChatInput('session-a', 'hello');
  assert.ok(handle);
  const request = sent[0];
  assert.equal(request?.type, 'terminal_chat_input');
  if (request?.type !== 'terminal_chat_input') return;

  internals.handleMessage({
    type: 'terminal_chat_input_result',
    requestId: 'different-request',
    sessionId: 'session-a',
    written: false,
  });
  internals.handleMessage({
    type: 'terminal_chat_input_result',
    requestId: request.requestId,
    sessionId: 'session-a',
    written: true,
  });
  assert.equal(await handle.submitted, true);
});

test('terminal chat routing acknowledges an unavailable managed runtime', async () => {
  const replies: ServerTransportMessage[] = [];
  await routeClientTransportMessage({
    connectionId: 'connection-a',
    userId: 'user-a',
    message: {
      type: 'terminal_chat_input',
      requestId: 'request-a',
      sessionId: 'missing-runtime',
      text: 'hello',
    },
    sendToConnection: (_connectionId, message) => { replies.push(message); },
    sendToUser: () => undefined,
  });

  assert.deepEqual(replies, [{
    type: 'terminal_chat_input_result',
    requestId: 'request-a',
    sessionId: 'missing-runtime',
    written: false,
  }]);
});
