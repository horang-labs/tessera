import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const launcherSource = fs.readFileSync(
  new URL('../scripts/launch-electron-test-instances.ps1', import.meta.url),
  'utf8',
);
const stopSource = fs.readFileSync(
  new URL('../scripts/stop-electron-test-session.ps1', import.meta.url),
  'utf8',
);

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
