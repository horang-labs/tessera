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

test('raw prompt telemetry follows accepted Enter once and never exposes input or records rejected/unknown receipts', async () => {
  const previousSocket = globalThis.WebSocket;
  const previousWindow = globalThis.window;
  const previousFetch = globalThis.fetch;
  const beacons: Array<{ url: string; options?: RequestInit }> = [];
  Object.assign(globalThis, {
    WebSocket: Socket,
    window: { location: { protocol: 'http:', host: 'fixture:3100' } },
    fetch: async (url: string, options?: RequestInit) => { beacons.push({ url, options }); return new Response(); },
  });
  const client = new WebSocketClient();
  const terminalId = 'telemetry-terminal';
  try {
    client.connect('owner');
    const socket = Socket.last;
    client.createTerminal({ terminalId, surfaceId: 'normal', launch: { providerId: 'codex', sessionId: 'telemetry-session' } });
    const send = (data: string) => {
      const result = client.sendTerminalInputConfirmed(terminalId, 'normal', data);
      const requestId = socket.sent.at(-1)!.requestId;
      return { result, receipt: (outcome: string) => socket.receive({
        type: 'terminal_input_result', terminalId, surfaceId: 'normal', requestId, outcome,
      }) };
    };
    const text = send('private draft');
    text.receipt('accepted');
    assert.equal(await text.result, true);
    assert.deepEqual(beacons, [], 'ordinary accepted bytes are not a prompt submission');
    const enter = send('\r');
    assert.deepEqual(beacons, [], 'enqueue is not acceptance');
    enter.receipt('accepted');
    assert.equal(await enter.result, true);
    assert.deepEqual(beacons, [{ url: '/api/telemetry/prompt-beacon', options: {
      method: 'POST', headers: { 'X-Tessera-Provider': 'codex', 'X-Tessera-Source': 'pty_direct', 'X-Tessera-Form-Factor': 'desktop' }, keepalive: true,
    } }]);
    enter.receipt('accepted');
    for (const outcome of ['rejected', 'unknown']) {
      const next = send('\r');
      next.receipt(outcome);
      assert.equal(await next.result, false);
      next.receipt('accepted'); // A late receipt cannot change an already settled result.
    }
    assert.equal(beacons.length, 1);
    const disconnected = send('\r');
    client.disconnect();
    assert.equal(await disconnected.result, false);
    assert.equal(beacons.length, 1);
  } finally {
    client.disconnect(); clearRetainedTerminalInput(terminalId);
    Object.assign(globalThis, { WebSocket: previousSocket, window: previousWindow, fetch: previousFetch });
  }
});
