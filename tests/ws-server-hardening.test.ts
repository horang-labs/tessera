import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { connect, type Socket } from 'node:net';
import path from 'node:path';
import test from 'node:test';
import WebSocket from 'ws';
import {
  MAX_TCP_CONNECTIONS,
  MAX_WS_CONNECTIONS,
  WebSocketServer as TesseraWebSocketServer,
  WS_MAX_PAYLOAD_BYTES,
} from '../src/lib/ws/server';

async function listen(server: Server): Promise<number> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address === 'object');
  return address.port;
}

async function openWebSocket(port: number): Promise<WebSocket> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
    origin: 'http://localhost:3100',
  });
  await once(socket, 'open');
  return socket;
}

async function openDeviceWebSocket(port: number, deviceToken: string): Promise<WebSocket> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
    origin: 'http://localhost:3100',
    headers: { cookie: `device=${deviceToken}` },
  });
  await once(socket, 'open');
  return socket;
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function startRawUpgrade(
  port: number,
  pathname = '/ws',
  includeHost = true,
  origin = 'http://localhost:3100',
): {
  socket: Socket;
  response: Promise<Buffer>;
  closed: Promise<void>;
} {
  const socket = connect(port, '127.0.0.1');
  let received = Buffer.alloc(0);
  let responseSettled = false;
  let resolveResponse!: (value: Buffer) => void;
  let rejectResponse!: (error: Error) => void;
  const response = new Promise<Buffer>((resolve, reject) => {
    resolveResponse = resolve;
    rejectResponse = reject;
  });
  const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()));

  socket.on('connect', () => {
    socket.write([
      `GET ${pathname} HTTP/1.1`,
      ...(includeHost ? [`Host: 127.0.0.1:${port}`] : []),
      `Origin: ${origin}`,
      'Connection: Upgrade',
      'Upgrade: websocket',
      `Sec-WebSocket-Key: ${randomBytes(16).toString('base64')}`,
      'Sec-WebSocket-Version: 13',
      '',
      '',
    ].join('\r\n'));
  });
  socket.on('data', (chunk) => {
    received = Buffer.concat([received, chunk]);
    const headersEnd = received.indexOf('\r\n\r\n');
    const minimumFrameBytes = pathname === '/ws' ? 4 : 0;
    if (
      !responseSettled
      && headersEnd >= 0
      && received.length >= headersEnd + 4 + minimumFrameBytes
    ) {
      responseSettled = true;
      resolveResponse(received);
    }
  });
  socket.on('error', (error) => {
    if (!responseSettled) {
      responseSettled = true;
      rejectResponse(error);
    }
  });
  socket.on('close', () => {
    if (!responseSettled) {
      responseSettled = true;
      resolveResponse(received);
    }
  });

  return { socket, response, closed };
}

function readCloseCode(response: Buffer): number {
  const headersEnd = response.indexOf('\r\n\r\n');
  assert(headersEnd >= 0, 'upgrade response should contain HTTP headers');
  assert.match(response.subarray(0, headersEnd).toString(), /^HTTP\/1\.1 101 /);
  const frame = response.subarray(headersEnd + 4);
  assert.equal(frame[0], 0x88, 'server should send a final close frame');
  const payloadLength = frame[1] & 0x7f;
  assert(payloadLength >= 2, 'close frame should contain a status code');
  return frame.readUInt16BE(2);
}

async function closeServer(
  transport: TesseraWebSocketServer,
  server: Server,
  clients: WebSocket[] = [],
): Promise<void> {
  for (const client of clients) client.terminate();
  await transport.shutdown();
  if (server.listening) {
    server.close();
    await once(server, 'close');
  }
}

test('bounds TCP and WebSocket connections and force-terminates an over-capacity peer', async () => {
  process.env.TESSERA_ELECTRON_AUTH_BYPASS = '1';
  const httpServer = createServer();
  const transport = new TesseraWebSocketServer({
    maxConnections: 2,
    rejectionGraceMs: 25,
    heartbeatIntervalMs: 60_000,
  });
  const port = await listen(httpServer);
  transport.start(httpServer);
  const clients = [await openWebSocket(port), await openWebSocket(port)];

  try {
    await waitFor(() => transport.listConnections().length === 2);
    assert.equal(httpServer.maxConnections, MAX_TCP_CONNECTIONS);
    assert.deepEqual(
      transport.listConnections().map(({ kind }) => kind),
      ['app', 'app'],
    );

    const rejected = startRawUpgrade(port);
    const response = await rejected.response;
    assert.equal(readCloseCode(response), 1013);
    await rejected.closed;
    assert.equal(rejected.socket.destroyed, true);
  } finally {
    await closeServer(transport, httpServer, clients);
    delete process.env.TESSERA_ELECTRON_AUTH_BYPASS;
  }
});

test('force-terminates an unauthenticated peer after sending policy close 1008', async () => {
  delete process.env.TESSERA_ELECTRON_AUTH_BYPASS;
  const httpServer = createServer();
  const transport = new TesseraWebSocketServer({
    rejectionGraceMs: 25,
    heartbeatIntervalMs: 60_000,
  });
  const port = await listen(httpServer);
  transport.start(httpServer);

  try {
    const rejected = startRawUpgrade(port);
    const response = await rejected.response;
    assert.equal(readCloseCode(response), 1008);
    await rejected.closed;
    assert.equal(rejected.socket.destroyed, true);
  } finally {
    await closeServer(transport, httpServer);
  }
});

test('force-terminates every open connection authenticated by a revoked device', async () => {
  delete process.env.TESSERA_ELECTRON_AUTH_BYPASS;
  const previousDataDir = process.env.TESSERA_DATA_DIR;
  const previousElectronRuntime = process.env.TESSERA_ELECTRON_RUNTIME;
  const previousPort = process.env.PORT;
  const dataDir = await mkdtemp(path.join(process.cwd(), '.tessera-ws-device-revoke-'));
  process.env.TESSERA_DATA_DIR = dataDir;
  process.env.TESSERA_ELECTRON_RUNTIME = '1';
  process.env.PORT = '3100';
  const registry = await import('../src/lib/auth/device-registry');
  await registry.clearDeviceRegistry();
  const pairing = await registry.issuePairingToken();
  const device = await registry.redeemPairingToken(pairing.token, 'Revoked phone');
  const httpServer = createServer();
  const transport = new TesseraWebSocketServer({ heartbeatIntervalMs: 60_000 });
  const port = await listen(httpServer);
  transport.start(httpServer);
  const client = await openDeviceWebSocket(port, device.token);

  try {
    await waitFor(() => transport.listConnections().length === 1);
    assert.deepEqual(transport.listConnections().map(({ kind, deviceId }) => ({
      kind,
      deviceId,
    })), [{ kind: 'device', deviceId: device.id }]);
    const closed = once(client, 'close');
    assert.equal(transport.disconnectDevice(device.id), 1);
    const [closeCode] = await closed;
    assert.equal(closeCode, 1006);
    await waitFor(() => transport.listConnections().length === 0);
  } finally {
    await closeServer(transport, httpServer, [client]);
    if (previousDataDir === undefined) delete process.env.TESSERA_DATA_DIR;
    else process.env.TESSERA_DATA_DIR = previousDataDir;
    if (previousElectronRuntime === undefined) delete process.env.TESSERA_ELECTRON_RUNTIME;
    else process.env.TESSERA_ELECTRON_RUNTIME = previousElectronRuntime;
    if (previousPort === undefined) delete process.env.PORT;
    else process.env.PORT = previousPort;
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('rejects a disallowed WebSocket Origin even while Electron auth bypass is enabled', async () => {
  process.env.TESSERA_ELECTRON_AUTH_BYPASS = '1';
  const httpServer = createServer();
  const transport = new TesseraWebSocketServer({ heartbeatIntervalMs: 60_000 });
  const port = await listen(httpServer);
  transport.start(httpServer);
  const client = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
    origin: 'http://localhost:45678',
  });

  try {
    await once(client, 'open');
    const [code] = await Promise.race([
      once(client, 'close'),
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error('Timed out waiting for Origin rejection')), 250);
      }),
    ]);
    assert.equal(code, 1008);
  } finally {
    await closeServer(transport, httpServer, [client]);
    delete process.env.TESSERA_ELECTRON_AUTH_BYPASS;
  }
});

test('destroys a malformed upgrade without taking down the HTTP server', async () => {
  const httpServer = createServer((_request, response) => {
    response.writeHead(204).end();
  });
  const transport = new TesseraWebSocketServer({ heartbeatIntervalMs: 60_000 });
  const port = await listen(httpServer);
  transport.start(httpServer);

  try {
    const socket = connect(port, '127.0.0.1');
    await once(socket, 'connect');
    socket.write([
      'GET /ws HTTP/1.1',
      'Connection: Upgrade',
      'Upgrade: websocket',
      `Sec-WebSocket-Key: ${randomBytes(16).toString('base64')}`,
      'Sec-WebSocket-Version: 13',
      '',
      '',
    ].join('\r\n'));
    await once(socket, 'close');

    const response = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(response.status, 204);
  } finally {
    await closeServer(transport, httpServer);
  }
});

test('keeps image-sized frames and non-/ws upgrades available', async () => {
  process.env.TESSERA_ELECTRON_AUTH_BYPASS = '1';
  const previousDataDir = process.env.TESSERA_DATA_DIR;
  const databaseDir = await mkdtemp(path.join(process.cwd(), '.tessera-ws-hardening-'));
  process.env.TESSERA_DATA_DIR = databaseDir;
  const { initDatabase } = await import('../src/lib/db/database');
  await initDatabase();
  const httpServer = createServer();
  httpServer.on('upgrade', (request, socket) => {
    if (request.url === '/_next/webpack-hmr') {
      socket.end('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');
    }
  });
  const transport = new TesseraWebSocketServer({ heartbeatIntervalMs: 60_000 });
  const port = await listen(httpServer);
  transport.start(httpServer);
  const client = await openWebSocket(port);

  try {
    await waitFor(() => transport.listConnections().length === 1);
    const missingSessionId = 'image-payload-test-session';
    const imageDataLength = Math.ceil(5 * 1024 * 1024 * 4 / 3);
    const serverResponse = new Promise<void>((resolve) => {
      client.on('message', (data) => {
        const message = JSON.parse(data.toString()) as {
          type?: string;
          requestId?: string;
          sessionId?: string;
        };
        if (
          message.type === 'error'
          && (
            message.requestId === 'image-payload-test-request'
            || message.sessionId === missingSessionId
          )
        ) resolve();
      });
    });
    client.send(JSON.stringify({
      type: 'send_message',
      requestId: 'image-payload-test-request',
      sessionId: missingSessionId,
      content: Array.from({ length: 5 }, () => ({
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/png',
          data: 'A'.repeat(imageDataLength),
        },
      })),
    }));
    await serverResponse;
    assert.equal(client.readyState, WebSocket.OPEN);

    const hmr = startRawUpgrade(port, '/_next/webpack-hmr');
    const response = await hmr.response;
    assert.match(response.toString(), /^HTTP\/1\.1 101 Switching Protocols/);
    hmr.socket.destroy();

    const malformedHmr = startRawUpgrade(port, '/_next/webpack-hmr', false);
    const malformedResponse = await malformedHmr.response;
    assert.match(malformedResponse.toString(), /^HTTP\/1\.1 101 Switching Protocols/);
    malformedHmr.socket.destroy();
  } finally {
    await closeServer(transport, httpServer, [client]);
    delete process.env.TESSERA_ELECTRON_AUTH_BYPASS;
    if (previousDataDir === undefined) delete process.env.TESSERA_DATA_DIR;
    else process.env.TESSERA_DATA_DIR = previousDataDir;
    await rm(databaseDir, { recursive: true, force: true });
  }
});

test('production hardening defaults retain the existing image payload budget', () => {
  assert.equal(MAX_WS_CONNECTIONS, 128);
  assert.equal(MAX_TCP_CONNECTIONS, 256);
  assert.equal(WS_MAX_PAYLOAD_BYTES, 50 * 1024 * 1024);
});
