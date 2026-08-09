import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { LOOPBACK_SERVER_HOST } from '../electron/server-listener';

function source(relativePath: string): string {
  return fs.readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8');
}

test('the packaged backend contract has one loopback listener', () => {
  const serverChild = source('electron/server-child.ts');

  assert.equal(LOOPBACK_SERVER_HOST, '127.0.0.1');
  assert.match(serverChild, /const hostname = LOOPBACK_SERVER_HOST/);
  assert.match(serverChild, /server\.listen\(port, hostname/);
  assert.doesNotMatch(serverChild, /directListeners|networkInterfaces|0\.0\.0\.0/);
  assert.doesNotMatch(source('electron/main.ts'), /TESSERA_ELECTRON_PACKAGED/);
});

test('Electron exposes only Serve setup for remote transport', () => {
  const main = source('electron/main.ts');
  const preload = source('electron/preload.ts');

  for (const retiredContract of [
    'get-remote-access-address-candidates',
    'supports-tailscale-firewall-configuration',
    'configure-tailscale-firewall',
  ]) {
    assert.doesNotMatch(main, new RegExp(retiredContract));
    assert.doesNotMatch(preload, new RegExp(retiredContract));
  }
  assert.match(main, /start-mobile-access-setup/);
  assert.match(preload, /start-mobile-access-setup/);
});

test('Remote Access UI has no manual listener or firewall controls', () => {
  const settings = source('src/components/settings/remote-access-section.tsx');

  assert.doesNotMatch(settings, /advertised-address|getRemoteAccessAddressCandidates/);
  assert.doesNotMatch(settings, /configureTailscaleFirewall|systemFirewallDescription/);
  assert.match(settings, /mobileAccessStatus\?\.state === 'ready'/);
});
