#!/usr/bin/env node

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const path = require('node:path');

function option(name) {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length) ?? null;
}

const repo = path.resolve(process.argv[2] ?? '');
const sessionId = option('session-id');
const certificatePath = path.resolve(option('certificate') ?? '');
const keyPath = path.resolve(option('key') ?? '');
if (!repo || !sessionId || !certificatePath || !keyPath) {
  throw new Error('Usage: electron-mobile-access-controlled.e2e.cjs <repo> '
    + '--session-id=<id> --certificate=<pem> --key=<pem>');
}

const testRoot = path.join(process.env.LOCALAPPDATA, 'TesseraTestInstances');
const manifestPath = path.join(testRoot, 'sessions', `${sessionId}.json`);
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8').replace(/^\uFEFF/, ''));
assert.equal(manifest.schemaVersion, 2);
assert.equal(manifest.sessionId, sessionId);
assert.equal(manifest.instances.length, 1);
const instance = manifest.instances[0];
assert.equal(instance.ready, true);
assert.notEqual(instance.serverPort, 32123);
assert.equal(instance.databaseSha256, null);
assert.equal(path.dirname(instance.dataDir), instance.instanceRoot);
assert.equal(path.dirname(instance.userDataDir), instance.instanceRoot);
assert.equal(path.dirname(instance.tailscaleExecutable), path.join(instance.instanceRoot, 'tools'));
assert.equal(path.dirname(instance.nodeExtraCaCert), path.join(instance.instanceRoot, 'tools'));

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

assert.equal(sha256(instance.tailscaleExecutable), instance.tailscaleExecutableSha256);
assert.equal(sha256(instance.nodeExtraCaCert), instance.nodeExtraCaCertSha256);

const ca = fs.readFileSync(certificatePath);
const proxy = https.createServer({ cert: ca, key: fs.readFileSync(keyPath) }, (request, response) => {
  const upstream = http.request({
    host: '127.0.0.1',
    port: instance.serverPort,
    method: request.method,
    path: request.url,
    headers: request.headers,
  }, (upstreamResponse) => {
    response.writeHead(upstreamResponse.statusCode, upstreamResponse.headers);
    upstreamResponse.pipe(response);
  });
  upstream.on('error', (error) => response.destroy(error));
  request.pipe(upstream);
});
proxy.on('upgrade', (request, client, head) => {
  const upstream = net.connect(instance.serverPort, '127.0.0.1', () => {
    const headers = request.rawHeaders.map((value, index) => (
      index % 2 === 0 ? `${value}: ` : `${value}\r\n`
    )).join('');
    upstream.write(`${request.method} ${request.url} HTTP/${request.httpVersion}\r\n${headers}\r\n`);
    if (head.length > 0) upstream.write(head);
    client.pipe(upstream).pipe(client);
  });
  upstream.on('error', () => client.destroy());
});

function request(pathname, headers = {}) {
  return new Promise((resolve, reject) => {
    const outgoing = https.request({
      hostname: 'localhost', port: 10_443, path: pathname, ca, headers,
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    outgoing.on('error', reject);
    outgoing.end();
  });
}

function websocketResult(WebSocket, headers = {}) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket('wss://localhost:10443/ws', {
      ca,
      origin: 'https://localhost:10443',
      headers,
    });
    const timeout = setTimeout(() => socket.terminate(), 5_000);
    socket.once('open', () => {
      if (headers['x-tessera-app-secret']) socket.close(1000, 'verified');
    });
    socket.once('close', (code, reason) => {
      clearTimeout(timeout);
      resolve({ code, reason: reason.toString() });
    });
    socket.once('error', (error) => {
      if (!headers['x-tessera-app-secret']) return;
      clearTimeout(timeout);
      reject(error);
    });
  });
}

async function main() {
  let browser;
  try {
  await new Promise((resolve, reject) => {
    proxy.once('error', reject);
    proxy.listen(10_443, '127.0.0.1', resolve);
  });
  const { chromium } = require(path.join(repo, 'node_modules', '@playwright', 'test'));
  const WebSocket = require(path.join(repo, 'node_modules', 'ws'));
  browser = await chromium.connectOverCDP(instance.cdpUrl);
  const page = browser.contexts().flatMap((context) => context.pages())[0];
  assert.ok(page);
  await page.waitForLoadState('domcontentloaded', { timeout: 30_000 });

  const setup = await page.evaluate(() => window.electronAPI.startMobileAccessSetup());
  assert.deepEqual(setup, { state: 'ready', origin: 'https://localhost:10443' });
  const pairing = await page.evaluate(() => window.electronAPI.createPairingCode('issue'));
  assert.equal(pairing.ok, true);
  assert.match(pairing.pairingLink, /^https:\/\/localhost:10443\/pair#t=/);

  const appSecret = fs.readFileSync(path.join(instance.dataDir, 'auth', 'app-secret'), 'utf8').trim();
  assert.equal((await request('/api/settings')).status, 401);
  assert.equal((await request('/api/settings', { 'x-tessera-app-secret': appSecret })).status, 200);
  assert.deepEqual(await websocketResult(WebSocket), { code: 1008, reason: 'Unauthorized' });
  assert.equal((await websocketResult(WebSocket, {
    'x-tessera-app-secret': appSecret,
  })).code, 1000);

  const removal = await page.evaluate(() => window.electronAPI.removeMobileAccess());
  assert.deepEqual(removal, { ok: true, status: { state: 'not-configured' } });
  const logPath = path.join(path.dirname(instance.tailscaleExecutable), 'fake-tailscale-invocations.tsv');
  const invocations = fs.readFileSync(logPath, 'utf8').trim().split(/\r?\n/).map((line) => {
    const [, pid, os, executable, args] = line.split('\t');
    return { pid: Number(pid), os, executable, args: args.split('\u001f') };
  });
  assert.equal(invocations.every(({ os }) => /Windows/i.test(os)), true);
  assert.equal(invocations.every(({ executable }) => executable === instance.tailscaleExecutable), true);
  assert.equal(invocations.some(({ args }) => args.at(-1) === 'off'), true);
  assert.equal(invocations.some(({ args }) => args.includes('reset') || args.includes('funnel')), false);

  process.stdout.write(`${JSON.stringify({
    rendererUrl: page.url(),
    backendPort: instance.serverPort,
    setup,
    pairingOrigin: new URL(pairing.pairingLink).origin,
    serveHttp: { unauthenticated: 401, authenticated: 200 },
    serveWebSocket: { unauthenticated: 1008, authenticated: 1000 },
    windowsTailscaleInvocations: invocations,
    removal,
  }, null, 2)}\n`);
  } finally {
    await browser?.close().catch(() => undefined);
    await new Promise((resolve) => proxy.close(resolve));
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
