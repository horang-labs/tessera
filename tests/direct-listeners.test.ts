import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import {
  DirectListenerRegistry,
  type DirectListenerTarget,
} from '../src/lib/http/direct-listeners';

/** Long enough that only explicit sync() calls drive these tests. */
const NO_AUTO_RETRY_MS = 3_600_000;

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => { probe.listen(0, '127.0.0.1', resolve); });
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => { probe.close(() => resolve()); });
  return port;
}

async function waitFor(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for the direct listener');
    await new Promise((resolve) => { setTimeout(resolve, 10); });
  }
}

/** Records bind/close calls without touching a real socket. */
function recordingServer(bound: string[], closed: string[]): Server {
  const server = new EventEmitter() as unknown as Server;
  let host = '';

  Object.assign(server, {
    listen(_port: number, listenHost: string) {
      host = listenHost;
      bound.push(listenHost);
      setImmediate(() => server.emit('listening'));
      return server;
    },
    close(callback?: () => void) {
      closed.push(host);
      callback?.();
      return server;
    },
  });

  return server;
}

test('the direct listener serves requests while configured and releases the address after', async () => {
  const port = await freePort();
  let target: DirectListenerTarget = { host: null, pending: false };

  const registry = new DirectListenerRegistry(NO_AUTO_RETRY_MS);
  registry.configure({
    port,
    createListener: () => createServer((_req, res) => { res.writeHead(200).end('direct'); }),
    resolveTarget: async () => target,
  });

  // Remote access off: nothing beyond the loopback listener the app owns.
  await registry.sync();
  assert.deepEqual(registry.activeHosts(), []);

  target = { host: '127.0.0.1', pending: false };
  await registry.sync();
  assert.deepEqual(registry.activeHosts(), ['127.0.0.1']);
  assert.equal(await (await fetch(`http://127.0.0.1:${port}/`)).text(), 'direct');

  target = { host: null, pending: false };
  await registry.sync();
  assert.deepEqual(registry.activeHosts(), []);
  await assert.rejects(fetch(`http://127.0.0.1:${port}/`));

  await registry.closeAll();
});

test('a direct listener that cannot bind never takes the server down', async () => {
  const port = await freePort();
  const blocker = createServer();
  await new Promise<void>((resolve) => { blocker.listen(port, '127.0.0.1', resolve); });

  const registry = new DirectListenerRegistry(NO_AUTO_RETRY_MS);
  registry.configure({
    port,
    createListener: () => createServer(),
    resolveTarget: async () => ({ host: '127.0.0.1', pending: false }),
  });

  await registry.sync();
  assert.deepEqual(registry.activeHosts(), []);

  await registry.closeAll();
  await new Promise<void>((resolve) => { blocker.close(() => resolve()); });
});

test('a changed advertised address closes the old listener before binding the new one', async () => {
  const bound: string[] = [];
  const closed: string[] = [];
  let target: DirectListenerTarget = { host: '100.70.80.90', pending: false };

  const registry = new DirectListenerRegistry(NO_AUTO_RETRY_MS);
  registry.configure({
    port: 32_123,
    createListener: () => recordingServer(bound, closed),
    resolveTarget: async () => target,
  });

  await registry.sync();
  assert.deepEqual(bound, ['100.70.80.90']);
  assert.deepEqual(closed, []);

  // Re-syncing an unchanged address must not churn the listener.
  await registry.sync();
  assert.deepEqual(bound, ['100.70.80.90']);
  assert.deepEqual(closed, []);

  target = { host: '100.70.80.91', pending: false };
  await registry.sync();
  assert.deepEqual(bound, ['100.70.80.90', '100.70.80.91']);
  assert.deepEqual(closed, ['100.70.80.90']);
  assert.deepEqual(registry.activeHosts(), ['100.70.80.91']);

  await registry.closeAll();
  assert.deepEqual(registry.activeHosts(), []);
});

test('remote access configured before Tailscale is up binds once the address appears', async () => {
  const port = await freePort();
  // Tailscale still starting: the setting is on, but no address matches yet.
  let target: DirectListenerTarget = { host: null, pending: true };

  const registry = new DirectListenerRegistry(20);
  registry.configure({
    port,
    createListener: () => createServer((_req, res) => { res.writeHead(200).end('late'); }),
    resolveTarget: async () => target,
  });

  await registry.sync();
  assert.deepEqual(registry.activeHosts(), []);

  target = { host: '127.0.0.1', pending: false };
  await waitFor(() => registry.activeHosts().length === 1);
  assert.equal(await (await fetch(`http://127.0.0.1:${port}/`)).text(), 'late');

  await registry.closeAll();
});

test('an unconfigured registry is inert for the plain web server', async () => {
  const registry = new DirectListenerRegistry(NO_AUTO_RETRY_MS);

  await registry.sync();
  assert.deepEqual(registry.activeHosts(), []);
  await registry.closeAll();
});
