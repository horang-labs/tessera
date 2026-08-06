import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import type { NetworkInterfaceInfo } from 'node:os';

import {
  LOOPBACK_SERVER_HOST,
  resolveDirectListenerHost,
  resolveDirectListenerTarget,
} from '../electron/server-listener';
import {
  buildRemoteAccessAddressCandidates,
  collectExternalIpv4Addresses,
  isTailscaleIpv4,
} from '../electron/network-addresses';
import { supportsTailscaleFirewallConfiguration } from '../electron/tailscale-firewall-capability';
import {
  TAILSCALE_ADAPTER_NOT_FOUND_EXIT_CODE,
  buildTailscaleFirewallScript,
  configureTailscaleFirewall,
} from '../electron/windows-firewall';
import { normalizeAdvertisedAddress } from '../src/lib/auth/advertised-address';

const TAILNET_INTERFACES = { Tailscale: [ipv4('100.70.80.90')] };
const TAILNET_ADDRESS = 'http://100.70.80.90:32123';

test('packaged desktop servers take the advertised address as a direct listener', () => {
  assert.equal(LOOPBACK_SERVER_HOST, '127.0.0.1');

  for (const platform of ['win32', 'darwin', 'linux'] satisfies NodeJS.Platform[]) {
    assert.deepEqual(
      resolveDirectListenerTarget({
        platform,
        isPackaged: true,
        advertisedAddress: TAILNET_ADDRESS,
        interfaces: TAILNET_INTERFACES,
      }),
      { host: '100.70.80.90', pending: false },
      platform,
    );
  }

  assert.deepEqual(
    resolveDirectListenerTarget({
      platform: 'freebsd',
      isPackaged: true,
      advertisedAddress: TAILNET_ADDRESS,
      interfaces: TAILNET_INTERFACES,
    }),
    { host: null, pending: false },
  );
});

test('a packaged server without remote access configured never leaves loopback', () => {
  for (const advertisedAddress of [null, undefined, '']) {
    assert.deepEqual(
      resolveDirectListenerTarget({
        platform: 'win32',
        isPackaged: true,
        advertisedAddress,
        interfaces: TAILNET_INTERFACES,
      }),
      { host: null, pending: false },
      String(advertisedAddress),
    );
  }
});

test('unpackaged Electron server children keep their listener on loopback', () => {
  for (const platform of ['win32', 'darwin', 'linux'] satisfies NodeJS.Platform[]) {
    assert.deepEqual(
      resolveDirectListenerTarget({
        platform,
        isPackaged: false,
        advertisedAddress: TAILNET_ADDRESS,
        interfaces: TAILNET_INTERFACES,
      }),
      { host: null, pending: false },
      platform,
    );
  }
});

test('remote access configured before its interface exists stays pending, not abandoned', () => {
  assert.deepEqual(
    resolveDirectListenerTarget({
      platform: 'win32',
      isPackaged: true,
      advertisedAddress: TAILNET_ADDRESS,
      interfaces: { Ethernet: [ipv4('192.168.1.20')] },
    }),
    { host: null, pending: true },
  );
});

test('only an advertised address that belongs to a live interface becomes a listener', () => {
  const interfaces = {
    Ethernet: [ipv4('192.168.1.20')],
    Tailscale: [ipv4('100.70.80.90')],
  };

  assert.equal(
    resolveDirectListenerHost('http://100.70.80.90:32123', interfaces),
    '100.70.80.90',
  );
  // The user may advertise a LAN address on purpose; that stays their choice.
  assert.equal(
    resolveDirectListenerHost('http://192.168.1.20:32123', interfaces),
    '192.168.1.20',
  );

  for (const advertised of [
    'https://tunnel.example.com',        // tunnelled — its client dials loopback
    'http://100.70.80.91:32123',         // tailnet address this machine lost
    'http://127.0.0.1:32123',            // loopback is already served
    'http://0.0.0.0:32123',              // never a real destination
    'http://[fd7a:115c:a1e0::1]:32123',  // IPv6 interfaces are not bound directly
    'not-a-url',
  ]) {
    assert.equal(resolveDirectListenerHost(advertised, interfaces), null, advertised);
  }
});

test('the normal web server keeps its explicit loopback default', () => {
  const source = fs.readFileSync(new URL('../server.ts', import.meta.url), 'utf8');

  assert.match(source, /process\.env\.TESSERA_HOST \|\| process\.env\.HOST \|\| '127\.0\.0\.1'/);
  assert.doesNotMatch(source, /resolveElectronServerHost/);
});

test('Tailscale IPv4 detection covers exactly the 100.64.0.0/10 range', () => {
  for (const address of ['100.64.0.0', '100.83.42.9', '100.127.255.255']) {
    assert.equal(isTailscaleIpv4(address), true, address);
  }
  for (const address of ['100.63.255.255', '100.128.0.0', '10.64.0.1', '100.64.0.0.1']) {
    assert.equal(isTailscaleIpv4(address), false, address);
  }
});

function ipv4(
  address: string,
  { internal = false, family = 'IPv4' }: { internal?: boolean; family?: string } = {},
): NetworkInterfaceInfo {
  return {
    address,
    netmask: '255.255.255.0',
    family,
    mac: '00:00:00:00:00:00',
    internal,
    cidr: `${address}/24`,
  } as NetworkInterfaceInfo;
}

test('external IPv4 discovery keeps interface names, filters unsafe addresses, and prefers Tailscale', () => {
  const addresses = collectExternalIpv4Addresses({
    Ethernet: [ipv4('192.168.1.20')],
    Loopback: [ipv4('127.0.0.1', { internal: true })],
    MisreportedLoopback: [ipv4('127.0.0.2')],
    Wildcard: [ipv4('0.0.0.0')],
    Tailscale: [ipv4('100.70.80.90')],
    IPv6: [ipv4('fd7a:115c:a1e0::1', { family: 'IPv6' })],
    Duplicate: [ipv4('192.168.1.20')],
  });

  assert.deepEqual(addresses, [
    { interfaceName: 'Tailscale', address: '100.70.80.90', isTailscale: true },
    { interfaceName: 'Ethernet', address: '192.168.1.20', isTailscale: false },
  ]);
});

test('advertised address candidates use the actual Tessera port', () => {
  assert.deepEqual(
    buildRemoteAccessAddressCandidates({
      Ethernet: [ipv4('10.10.0.8')],
      Tailscale: [ipv4('100.91.2.3')],
    }, 43_210),
    [
      {
        interfaceName: 'Tailscale',
        address: '100.91.2.3',
        isTailscale: true,
        url: 'http://100.91.2.3:43210',
      },
      {
        interfaceName: 'Ethernet',
        address: '10.10.0.8',
        isTailscale: false,
        url: 'http://10.10.0.8:43210',
      },
    ],
  );
});

test('the wildcard listener address can never become an advertised address', () => {
  assert.throws(
    () => normalizeAdvertisedAddress('http://0.0.0.0:32123'),
    /wildcard/i,
  );
});

test('firewall configuration is limited to packaged Windows product instances', () => {
  assert.equal(supportsTailscaleFirewallConfiguration({
    platform: 'win32',
    devServerPort: '',
    testInstance: '',
  }), true);
  assert.equal(supportsTailscaleFirewallConfiguration({
    platform: 'win32',
    devServerPort: '32123',
  }), false);
  assert.equal(supportsTailscaleFirewallConfiguration({
    platform: 'win32',
    testInstance: 'ticket-14',
  }), false);
  assert.equal(supportsTailscaleFirewallConfiguration({
    platform: 'linux',
    devServerPort: '',
    testInstance: '',
  }), false);
  assert.equal(supportsTailscaleFirewallConfiguration({
    platform: 'darwin',
    devServerPort: '',
    testInstance: '',
  }), false);
});

test('the Electron child serves loopback itself and delegates remote access to a second listener', () => {
  const source = fs.readFileSync(
    new URL('../electron/server-child.ts', import.meta.url),
    'utf8',
  );
  const mainSource = fs.readFileSync(new URL('../electron/main.ts', import.meta.url), 'utf8');
  const listenerSource = fs.readFileSync(
    new URL('../electron/server-listener.ts', import.meta.url),
    'utf8',
  );

  assert.match(source, /const hostname = LOOPBACK_SERVER_HOST;/);
  assert.match(source, /server\.listen\(port, hostname,/);
  assert.match(source, /directListeners\.configure\(\{/);
  assert.match(source, /wsServer\.attach\(listener\)/);
  assert.match(source, /await directListeners\.sync\(\)/);
  assert.match(source, /directListeners\.closeAll\(\)/);
  assert.match(mainSource, /TESSERA_ELECTRON_PACKAGED: isPackaged \? '1' : '0'/);

  // The Windows Defender prompt on every launch came from the wildcard bind.
  assert.doesNotMatch(source, /0\.0\.0\.0/);
  assert.doesNotMatch(listenerSource, /'0\.0\.0\.0'/);
});

test('saving the remote access address rebinds without an app restart', () => {
  const source = fs.readFileSync(
    new URL('../src/app/api/settings/route.ts', import.meta.url),
    'utf8',
  );

  assert.match(source, /import \{ directListeners \} from '@\/lib\/http\/direct-listeners'/);
  assert.match(source, /await directListeners\.sync\(\)/);
});

test('Electron windows keep localhost origins while the packaged listener is external', () => {
  const source = fs.readFileSync(new URL('../electron/main.ts', import.meta.url), 'utf8');
  const localhostWindowUrls = source.match(/const url = `http:\/\/localhost:\$\{port\}/g) ?? [];

  assert.equal(localhostWindowUrls.length, 2, 'main and popout windows');
  assert.doesNotMatch(source, /loadURL\(`http:\/\/0\.0\.0\.0/);
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
  assert.match(mainSource, /if \(!supportsTailscaleFirewallConfiguration\(\)\)/);
  assert.match(mainSource, /configureTailscaleFirewall\(\{ port: serverPort \}\)/);
  assert.match(mainSource, /ipcMain\.on\('supports-tailscale-firewall-configuration'/);
  assert.match(
    preloadSource,
    /supportsTailscaleFirewallConfiguration:\s*ipcRenderer\.sendSync\('supports-tailscale-firewall-configuration'\)/,
  );
  assert.doesNotMatch(preloadSource, /from '\.\/tailscale-firewall-capability'/);
  assert.match(preloadSource, /configureTailscaleFirewall: \(\) => ipcRenderer\.invoke\('configure-tailscale-firewall'\)/);
});

test('Electron exposes detected advertised addresses using the actual server port', () => {
  const mainSource = fs.readFileSync(new URL('../electron/main.ts', import.meta.url), 'utf8');
  const preloadSource = fs.readFileSync(new URL('../electron/preload.ts', import.meta.url), 'utf8');

  assert.match(mainSource, /networkInterfaces\(\)/);
  assert.match(mainSource, /buildRemoteAccessAddressCandidates\(networkInterfaces\(\), serverPort\)/);
  assert.match(mainSource, /ipcMain\.handle\('get-remote-access-address-candidates'/);
  assert.match(
    preloadSource,
    /getRemoteAccessAddressCandidates: \(\) =>\s*ipcRenderer\.invoke\('get-remote-access-address-candidates'\)/,
  );
});

test('remote access settings suggest detected addresses while preserving manual entry', () => {
  const source = fs.readFileSync(
    new URL('../src/components/settings/remote-access-section.tsx', import.meta.url),
    'utf8',
  );

  assert.match(source, /getRemoteAccessAddressCandidates/);
  assert.match(source, /advertisedAddress \?\? addressCandidates\[0\]\?\.url \?\? ''/);
  assert.match(source, /addressCandidates\.map/);
  assert.match(source, /setAddress\(candidate\.url\)/);
  assert.match(source, /type="url"/);
  assert.match(source, /platform === 'darwin' \|\| electronApi\.platform === 'linux'/);
  assert.match(source, /systemFirewallDescription/);
});
