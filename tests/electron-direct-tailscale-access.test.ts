import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import {
  LOOPBACK_SERVER_HOST,
  WINDOWS_REMOTE_SERVER_HOST,
  resolveElectronServerHost,
} from '../electron/server-listener';
import {
  TAILSCALE_ADAPTER_NOT_FOUND_EXIT_CODE,
  buildTailscaleFirewallScript,
  configureTailscaleFirewall,
} from '../electron/windows-firewall';

test('the packaged Windows server listens on external IPv4 interfaces only on Windows', () => {
  assert.equal(resolveElectronServerHost('win32'), WINDOWS_REMOTE_SERVER_HOST);
  assert.equal(WINDOWS_REMOTE_SERVER_HOST, '0.0.0.0');
  assert.equal(resolveElectronServerHost('darwin'), LOOPBACK_SERVER_HOST);
  assert.equal(resolveElectronServerHost('linux'), LOOPBACK_SERVER_HOST);
  assert.equal(LOOPBACK_SERVER_HOST, '127.0.0.1');
});

test('the Electron child resolves its listener host instead of hard-coding loopback', () => {
  const source = fs.readFileSync(
    new URL('../electron/server-child.ts', import.meta.url),
    'utf8',
  );

  assert.match(source, /const hostname = resolveElectronServerHost\(\);/);
  assert.doesNotMatch(source, /const hostname = ['"]127\.0\.0\.1['"]/);
  assert.match(source, /server\.listen\(port, hostname,/);
});

test('the Windows Firewall rule is limited to the actual TCP port and Tailscale adapters', () => {
  const script = buildTailscaleFirewallScript(32_123);

  assert.match(script, /Get-NetAdapter -IncludeHidden/);
  assert.match(script, /InterfaceDescription -like '\*Tailscale\*'/);
  assert.match(script, /-Direction Inbound/);
  assert.match(script, /-Protocol TCP/);
  assert.match(script, /-LocalPort 32123/);
  assert.match(script, /-InterfaceAlias \$tailscaleAdapters/);
  assert.match(script, /-EdgeTraversalPolicy Block/);
  assert.doesNotMatch(script, /-LocalPort (?:Any|\*)/i);
  assert.doesNotMatch(script, /-InterfaceAlias (?:Any|\*)/i);
  assert.doesNotMatch(script, /-RemoteAddress (?:Any|\*)/i);
});

test('firewall setup requests elevation with an encoded, non-interpolated script', async () => {
  let invokedArgs: string[] | null = null;
  const result = await configureTailscaleFirewall({
    port: 32_124,
    platform: 'win32',
    runner: async (args) => {
      invokedArgs = args;
    },
  });

  assert.deepEqual(result, { ok: true });
  assert.ok(invokedArgs);
  const command = invokedArgs.at(-1) ?? '';
  assert.match(command, /Start-Process .* -Verb RunAs -Wait -PassThru/);
  const encodedScript = /'-EncodedCommand',\s*'([^']+)'/m.exec(command)?.[1];
  assert.ok(encodedScript);
  const script = Buffer.from(encodedScript, 'base64').toString('utf16le');
  assert.match(script, /-LocalPort 32124/);
});

test('firewall setup reports missing Tailscale adapters and unsupported platforms', async () => {
  assert.deepEqual(
    await configureTailscaleFirewall({ port: 32_123, platform: 'linux' }),
    {
      ok: false,
      code: 'unsupported',
      error: 'Windows Firewall configuration is only available on Windows',
    },
  );

  const missingAdapter = Object.assign(new Error('PowerShell exited'), {
    code: TAILSCALE_ADAPTER_NOT_FOUND_EXIT_CODE,
  });
  const result = await configureTailscaleFirewall({
    port: 32_123,
    platform: 'win32',
    runner: async () => {
      throw missingAdapter;
    },
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, 'tailscale-not-found');
});

test('the firewall action is exposed only through Electron main and preload IPC', () => {
  const mainSource = fs.readFileSync(new URL('../electron/main.ts', import.meta.url), 'utf8');
  const preloadSource = fs.readFileSync(new URL('../electron/preload.ts', import.meta.url), 'utf8');

  assert.match(mainSource, /ipcMain\.handle\('configure-tailscale-firewall'/);
  assert.match(mainSource, /if \(electronTestInstance \|\| process\.env\.TESSERA_DEV_PORT\)/);
  assert.match(mainSource, /configureTailscaleFirewall\(\{ port: serverPort \}\)/);
  assert.match(preloadSource, /supportsDirectTailscaleAccess:/);
  assert.match(preloadSource, /!process\.env\.TESSERA_DEV_PORT/);
  assert.match(preloadSource, /!process\.env\.TESSERA_ELECTRON_TEST_INSTANCE/);
  assert.match(preloadSource, /configureTailscaleFirewall: \(\) => ipcRenderer\.invoke\('configure-tailscale-firewall'\)/);
});
