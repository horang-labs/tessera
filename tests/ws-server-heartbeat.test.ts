import assert from 'node:assert/strict';
import test from 'node:test';
import type { WebSocket } from 'ws';
import { WebSocketServerHeartbeat } from '../src/lib/ws/server-heartbeat';

test('grants connected clients a fresh probe after the server resumes from suspension', (context) => {
  context.mock.timers.enable({ apis: ['setInterval'] });
  let now = 1_000;
  let pings = 0;
  let terminations = 0;
  const socket = {
    ping: () => { pings += 1; },
    terminate: () => { terminations += 1; },
  } as unknown as WebSocket;
  const heartbeat = new WebSocketServerHeartbeat(100, () => now);

  heartbeat.noteAlive(socket);
  heartbeat.start(() => [socket]);

  now += 100;
  context.mock.timers.tick(100);
  now += 3_600_000;
  context.mock.timers.tick(100);

  assert.equal(pings, 2);
  assert.equal(terminations, 0);

  now += 100;
  context.mock.timers.tick(100);
  assert.equal(terminations, 1);
  heartbeat.stop();
});
