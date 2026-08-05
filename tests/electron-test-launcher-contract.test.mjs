import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const launcherSource = fs.readFileSync(
  new URL('../scripts/launch-electron-test-instances.ps1', import.meta.url),
  'utf8',
);
const electronMainSource = fs.readFileSync(
  new URL('../electron/main.ts', import.meta.url),
  'utf8',
);
const stopSource = fs.readFileSync(
  new URL('../scripts/stop-electron-test-session.ps1', import.meta.url),
  'utf8',
);

test('normal packaged Electron retains stable port scanning', () => {
  assert.match(electronMainSource, /const ELECTRON_DEFAULT_PORT = 32123;/);
  assert.match(electronMainSource, /const ELECTRON_PORT_SCAN_LIMIT = 100;/);
  assert.match(electronMainSource, /async function findStablePort\(\): Promise<number>/);
  assert.match(electronMainSource, /const candidate = ELECTRON_DEFAULT_PORT \+ offset;/);
  assert.match(
    electronMainSource,
    /const port = electronTestInstance[\s\S]*resolveElectronServerPort\(ELECTRON_DEFAULT_PORT, electronTestInstance\)[\s\S]*await findStablePort\(\);/,
  );
  assert.doesNotMatch(electronMainSource, /srv\.listen\(0, '127\.0\.0\.1'/);
});

test('isolated Electron launcher assigns a distinct packaged server port', () => {
  assert.match(launcherSource, /\[int\]\$ServerBasePort = 32124/);
  assert.match(launcherSource, /Find-AvailableTcpPort -StartPort \(\$ServerBasePort \+ \$offset\)/);
  assert.match(launcherSource, /\$env:TESSERA_ELECTRON_TEST_SERVER_PORT = \[string\]\$testServerPort/);
  assert.match(launcherSource, /serverPort = \$testServerPort/);
  assert.match(launcherSource, /if \(\$cdp\.serverPort -ne \$testServerPort\)/);
});

test('failed launches with no surviving process can still be cleaned by manifest', () => {
  assert.match(
    stopSource,
    /\[AllowEmptyCollection\(\)\][\s\S]*\[array\]\$ProcessIds/,
  );
});
