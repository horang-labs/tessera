#!/usr/bin/env node

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const http = require('node:http');

function readOption(name) {
  const prefix = `--${name}=`;
  return process.argv.slice(2).find((value) => value.startsWith(prefix))?.slice(prefix.length) ?? null;
}

function asArray(value) {
  return value == null ? [] : Array.isArray(value) ? value : [value];
}

function loadOwnedInstance(sessionId, cdpUrl) {
  assert.match(sessionId, /^[A-Za-z0-9][A-Za-z0-9._-]{0,49}$/);
  const testRoot = path.join(process.env.LOCALAPPDATA, 'TesseraTestInstances');
  const manifestPath = path.join(testRoot, 'sessions', `${sessionId}.json`);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8').replace(/^\uFEFF/, ''));
  assert.equal(manifest.schemaVersion, 2);
  assert.equal(manifest.sessionId, sessionId);

  const instance = asArray(manifest.instances).find((candidate) => candidate.cdpUrl === cdpUrl);
  assert.ok(instance?.ready, 'CDP URL does not belong to a ready launcher-owned instance');
  const expectedRoot = path.join(testRoot, instance.instanceId);
  assert.equal(path.resolve(instance.instanceRoot).toLowerCase(), expectedRoot.toLowerCase());
  assert.equal(path.resolve(instance.dataDir).toLowerCase(), path.join(expectedRoot, 'data').toLowerCase());
  assert.match(instance.ownerToken, /^[a-f0-9]{32}$/);

  const processScript = `
    $process = Get-CimInstance Win32_Process -Filter 'ProcessId = ${Number(instance.electronProcessId)}'
    $cdpOwner = Get-NetTCPConnection -State Listen -LocalPort ${Number(instance.cdpPort)} |
      Where-Object { $_.LocalAddress -in @('127.0.0.1', '::1') } |
      Select-Object -First 1 -ExpandProperty OwningProcess
    [pscustomobject]@{
      ExecutablePath = $process.ExecutablePath
      CommandLine = $process.CommandLine
      CdpOwner = $cdpOwner
    } | ConvertTo-Json -Compress
  `;
  const processInfo = JSON.parse(execFileSync('powershell.exe', [
    '-NoProfile', '-Command', processScript,
  ], { encoding: 'utf8' }));
  assert.equal(processInfo.CdpOwner, Number(instance.electronProcessId));
  assert.equal(processInfo.ExecutablePath.toLowerCase(), manifest.executable.toLowerCase());
  assert.match(processInfo.CommandLine, new RegExp(`--tessera-test-owner=${instance.ownerToken}`));
  assert.match(processInfo.CommandLine, new RegExp(`--remote-debugging-port=${instance.cdpPort}`));
  return instance;
}

function inspectWindowsBindings(port) {
  const script = `
    $listeners = Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction Stop |
      Select-Object LocalAddress, LocalPort, OwningProcess
    $addresses = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
      Where-Object { $_.IPAddress -ne '127.0.0.1' -and $_.IPAddress -notlike '169.254.*' } |
      Select-Object -ExpandProperty IPAddress -Unique
    $probes = foreach ($address in @('127.0.0.1') + $addresses) {
      $client = [Net.Sockets.TcpClient]::new()
      try {
        $pending = $client.ConnectAsync($address, ${port})
        [pscustomobject]@{ Address = $address; Connected = $pending.Wait(2000) -and $client.Connected }
      } catch {
        [pscustomobject]@{ Address = $address; Connected = $false }
      } finally {
        $client.Dispose()
      }
    }
    [pscustomobject]@{ Listeners = @($listeners); Probes = @($probes) } |
      ConvertTo-Json -Depth 4 -Compress
  `;
  return JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-Command', script], {
    encoding: 'utf8',
  }));
}

function requestStatus(port, serveOrigin) {
  const serveUrl = new URL(serveOrigin);
  return new Promise((resolve, reject) => {
    const request = http.get({
      hostname: '127.0.0.1',
      port,
      path: '/api/projects',
      headers: { Host: serveUrl.host, Origin: serveUrl.origin },
    }, (response) => {
      response.resume();
      response.on('end', () => resolve(response.statusCode));
    });
    request.setTimeout(5_000, () => request.destroy(new Error('HTTP probe timed out')));
    request.on('error', reject);
  });
}

function websocketClose(repo, port, serveOrigin) {
  const WebSocket = require(path.join(repo, 'node_modules', 'ws'));
  const serveUrl = new URL(serveOrigin);
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
      headers: { Host: serveUrl.host, Origin: serveUrl.origin },
    });
    const timeout = setTimeout(() => {
      socket.terminate();
      reject(new Error('WebSocket probe timed out'));
    }, 5_000);
    socket.once('close', (code, reason) => {
      clearTimeout(timeout);
      resolve({ code, reason: reason.toString() });
    });
    socket.once('error', () => undefined);
  });
}

async function main() {
  const repo = path.resolve(process.argv[2] ?? '');
  const cdpUrl = readOption('cdp');
  const sessionId = readOption('session-id');
  const serveOrigin = new URL(readOption('serve-origin') ?? '').origin;
  if (!repo || !cdpUrl || !sessionId || !serveOrigin.startsWith('https://')) {
    throw new Error('Usage: electron-serve-only-security.e2e.cjs <repo> --cdp=<url> '
      + '--session-id=<launcher session> --serve-origin=<HTTPS origin>');
  }
  const instance = loadOwnedInstance(sessionId, cdpUrl);

  const { chromium } = require(path.join(repo, 'node_modules', '@playwright', 'test'));
  const browser = await chromium.connectOverCDP(cdpUrl);
  try {
    const page = browser.contexts().flatMap((context) => context.pages())[0];
    assert.ok(page, 'Electron CDP endpoint has no renderer page');
    await page.waitForLoadState('domcontentloaded', { timeout: 30_000 });
    assert.equal(await page.title(), 'Tessera');
    const electronUrl = new URL(page.url());
    assert.equal(electronUrl.pathname, '/chat');
    const port = Number(electronUrl.port);
    assert.notEqual(port, 32123, 'Refusing to test against the installed Tessera backend');
    assert.equal(port, Number(instance.serverPort));

    const bindings = inspectWindowsBindings(port);
    const listeners = asArray(bindings.Listeners);
    assert.deepEqual([...new Set(listeners.map((listener) => listener.LocalAddress))], ['127.0.0.1']);
    const probes = asArray(bindings.Probes);
    assert.equal(probes.find((probe) => probe.Address === '127.0.0.1')?.Connected, true);
    assert.ok(probes.filter((probe) => probe.Address !== '127.0.0.1').length > 0);
    assert.equal(probes.some((probe) => probe.Address !== '127.0.0.1' && probe.Connected), false);

    const serveUrl = new URL(serveOrigin);
    fs.writeFileSync(path.join(instance.dataDir, 'mobile-access.json'), JSON.stringify({
      schemaVersion: 1,
      owner: 'tessera.mobile-access',
      nodeDnsName: serveUrl.hostname,
      origin: serveUrl.origin,
      servePort: Number(serveUrl.port || 443),
      mountPath: '/',
      lastLoopbackTarget: `http://127.0.0.1:${port}`,
    }));

    assert.equal(await requestStatus(port, serveOrigin), 401);
    assert.deepEqual(await websocketClose(repo, port, serveOrigin), {
      code: 1008,
      reason: 'Unauthorized',
    });

    process.stdout.write(`${JSON.stringify({
      renderer: { title: 'Tessera', url: page.url() },
      listeners,
      probes,
      unauthenticatedServeHttpStatus: 401,
      unauthenticatedServeWebSocket: { code: 1008, reason: 'Unauthorized' },
    }, null, 2)}\n`);
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
