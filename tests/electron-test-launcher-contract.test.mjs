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
const electronMainSource = fs.readFileSync(
  new URL('../electron/main.ts', import.meta.url),
  'utf8',
);

test('isolated Electron launcher assigns a distinct packaged server port', () => {
  assert.match(launcherSource, /\[int\]\$ServerBasePort = 32124/);
  assert.match(launcherSource, /Find-AvailableTcpPort -StartPort \(\$ServerBasePort \+ \$offset\)/);
  assert.match(launcherSource, /\$env:TESSERA_ELECTRON_TEST_SERVER_PORT = \[string\]\$testServerPort/);
  assert.match(launcherSource, /serverPort = \$testServerPort/);
  assert.match(launcherSource, /if \(\$cdp\.serverPort -ne \$testServerPort\)/);
});

test('port allocation bind-probes candidates, rejects live Chromium claims, and serializes launchers', () => {
  assert.match(launcherSource, /function Test-TcpPortBindable/);
  assert.match(launcherSource, /\[System\.Net\.Sockets\.TcpListener\]::new/);
  assert.match(launcherSource, /\[System\.Net\.IPAddress\]::Loopback/);
  assert.match(launcherSource, /\$listener\.Start\(\)/);
  assert.match(launcherSource, /Test-TcpPortBindable -Port \$Port/);
  assert.doesNotMatch(launcherSource, /ConnectAsync\('127\.0\.0\.1', \$Port\)/);
  assert.match(launcherSource, /function Test-TcpPortClaimed/);
  assert.match(launcherSource, /--remote-debugging-port=\$Port/);
  assert.match(launcherSource, /Get-CimInstance Win32_Process -ErrorAction Stop/);
  assert.match(launcherSource, /Cannot verify whether TCP port \$Port is claimed/);
  assert.match(launcherSource, /-not \(Test-TcpPortClaimed -Port \$candidate\)/);
  assert.match(launcherSource, /Local\\TesseraElectronTestPortAllocation/);
  assert.match(launcherSource, /\$portAllocationMutex\.WaitOne/);
  assert.match(launcherSource, /\$portAllocationMutex\.ReleaseMutex\(\)/);
});

test('failed launches with no surviving process can still be cleaned by manifest', () => {
  assert.match(
    stopSource,
    /\[AllowEmptyCollection\(\)\][\s\S]*\[AllowNull\(\)\][\s\S]*\[array\]\$ProcessIds/,
  );
});

test('owned Downloads artifacts can be permanently removed without the Linux trash', () => {
  assert.match(launcherSource, /portableArtifact = \$PortableArtifactPath/);
  assert.match(stopSource, /\[switch\]\$RemoveBuildArtifacts/);
  assert.match(stopSource, /\$manifest\.portableArtifact/);
  assert.match(stopSource, /GetFolderPath\('UserProfile'\)/);
  assert.match(stopSource, /Test-PathWithinRoot -Path \$appDirectory -Root \$downloads/);
  assert.match(stopSource, /Refusing to remove a nested build directory/);
  assert.match(stopSource, /Remove-PathWithRetry -Path \$appDirectory/);
  assert.match(stopSource, /Remove-PathWithRetry -Path \$portableArtifact/);
  assert.doesNotMatch(stopSource, /gio\s+trash/i);
});

test('test window titles stay identifiable after renderer page-title updates', () => {
  assert.match(electronMainSource, /resolveElectronWindowTitle\('Tessera', electronTestInstance\)/);
  assert.match(electronMainSource, /resolveElectronWindowTitle\('Tessera Board', electronTestInstance\)/);
  assert.match(electronMainSource, /webContents\.on\('page-title-updated'/);
  assert.match(electronMainSource, /event\.preventDefault\(\)/);
  assert.match(electronMainSource, /win\.setTitle\(title\)/);
});
