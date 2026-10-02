import assert from 'node:assert/strict';
import test from 'node:test';
import { WebSocketClient } from '../src/lib/ws/client';
import { getSessionInputOwnership } from '../src/lib/automation/client-state';
import { getRetainedTerminalInput, clearRetainedTerminalInput } from '../src/lib/terminal/raw-input-buffer';

class Socket {
  static OPEN = 1; static CONNECTING = 0;
  static last: Socket;
  readyState = 1;
  sent: Array<{ requestId: string; inputEpoch?: string; data?: string }> = [];
  onmessage?: (event: { data: string }) => void;
  constructor() { Socket.last = this; }
  send(value: string) { this.sent.push(JSON.parse(value)); }
  close() { this.readyState = 3; }
  receive(value: object) { this.onmessage?.({ data: JSON.stringify(value) }); }
}

test('raw transport awaits ACK, includes the epoch, preserves unknown text, and reconnect ownership is read-only', async () => {
  const previousSocket = globalThis.WebSocket;
  const previousWindow = globalThis.window;
  Object.assign(globalThis, { WebSocket: Socket, window: { location: { protocol: 'http:', host: 'fixture:3100' } } });
  const client = new WebSocketClient();
  try {
    client.connect('owner');
    const socket = Socket.last;
    const human = { type: 'session_input_ownership', sessionId: 'transport-session', terminalId: 'transport-terminal',
      epoch: 'epoch-1', mode: 'human', automationId: null, runId: null, reason: null };
    socket.receive(human);
    let settled = false;
    const accepted = client.sendTerminalInputConfirmed('transport-terminal', 'normal', 'hello').then(value => { settled = true; return value; });
    await Promise.resolve();
    assert.equal(settled, false);
    assert.equal(socket.sent[0].inputEpoch, 'epoch-1');
    socket.receive({ type: 'terminal_input_result', requestId: socket.sent[0].requestId, terminalId: 'transport-terminal', surfaceId: 'normal', outcome: 'accepted', inputOwnership: human });
    assert.equal(await accepted, true);
    const uncertain = client.sendTerminalInputConfirmed('transport-terminal', 'peek', 'keep me');
    client.disconnect();
    assert.equal(await uncertain, false);
    assert.equal(getRetainedTerminalInput('transport-terminal'), 'keep me');
    assert.equal(getSessionInputOwnership('transport-session').mode, 'unavailable');
    socket.receive(human);
    assert.equal(getSessionInputOwnership('transport-session').mode, 'unavailable', 'old socket cannot restore writable input');
    client.connect('owner');
    assert.equal(Socket.last.sent.length, 0, 'uncertain text is not replayed');
  } finally {
    client.disconnect(); clearRetainedTerminalInput('transport-terminal');
    Object.assign(globalThis, { WebSocket: previousSocket, window: previousWindow });
  }
});
