import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const launcherSource = fs.readFileSync(
  new URL('../scripts/launch-electron-test-instances.ps1', import.meta.url),
  'utf8',
);
const stopSource = fs.readFileSync(
  new URL('../scripts/stop-electron-test-session.ps1', import.meta.url),
  'utf8',
);
const windowsPowerShellPath = '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';
const canRunWindowsPowerShell = Boolean(
  process.env.WSL_DISTRO_NAME
  && fs.existsSync(windowsPowerShellPath),
);

function runLaunchEnvironmentHarness(mode) {
  const harnessPath = fileURLToPath(
    new URL('./fixtures/electron-launch-environment-harness.ps1', import.meta.url),
  );
  const launcherPath = fileURLToPath(
    new URL('../scripts/launch-electron-test-instances.ps1', import.meta.url),
  );
  const toWindowsPath = (value) => execFileSync('wslpath', ['-w', value], {
    encoding: 'utf8',
  }).trim();
  const stdout = execFileSync(windowsPowerShellPath, [
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-File', toWindowsPath(harnessPath),
    '-Launcher', toWindowsPath(launcherPath),
    '-Mode', mode,
  ], {
    encoding: 'utf8',
    timeout: 30_000,
  });
  return JSON.parse(stdout);
}

function expectedRestoredEnvironment(result) {
  return {
    ...result.hostileEnvironment,
    TESSERA_ELECTRON_TEST_INSTANCE: 'caller-test-instance',
    TESSERA_ELECTRON_TEST_ROOT: 'C:\\caller-test-root',
    TESSERA_ELECTRON_TEST_SERVER_PORT: '39999',
    WSL_DISTRO_NAME: 'Caller-Distro',
  };
}

function assertHostileEnvironmentCleared(result, launch, context) {
  for (const name of Object.keys(result.hostileEnvironment)) {
    assert.equal(launch.environment[name], null, `${name} leaked ${context}`);
  }
}

test('isolated Electron child launches cannot inherit caller agent-session state', {
  skip: !canRunWindowsPowerShell,
}, () => {
  const result = runLaunchEnvironmentHarness('Success');

  assert.equal(result.launchError, null);
  assert.equal(result.launches.length, 2);
  for (const [index, launch] of result.launches.entries()) {
    assertHostileEnvironmentCleared(result, launch, `into launch ${index + 1}`);
    assert.equal(launch.environment.TESSERA_ELECTRON_TEST_INSTANCE, `env-contract-${index + 1}`);
    assert.equal(launch.environment.TESSERA_ELECTRON_TEST_ROOT.endsWith('tessera-launch-env-'), false);
    assert.match(launch.environment.TESSERA_ELECTRON_TEST_ROOT, /tessera-launch-env-[a-f0-9]{32}$/);
    assert.match(launch.environment.TESSERA_ELECTRON_TEST_SERVER_PORT, /^\d+$/);
    assert.equal(launch.environment.WSL_DISTRO_NAME, 'Ubuntu-24.04');
  }
  assert.deepEqual(result.restoredEnvironment, expectedRestoredEnvironment(result));
});

test('isolated Electron launcher restores caller environment when child launch fails', {
  skip: !canRunWindowsPowerShell,
}, () => {
  const result = runLaunchEnvironmentHarness('Failure');

  assert.match(result.launchError, /Synthetic Start-Process failure/);
  assert.equal(result.launches.length, 1);
  assertHostileEnvironmentCleared(result, result.launches[0], 'before failure');
  assert.deepEqual(result.restoredEnvironment, expectedRestoredEnvironment(result));
});

test('isolated Electron launcher fail-closes current and future agent namespaces', () => {
  assert.match(launcherSource, /GetEnvironmentVariables\('Process'\)\.Keys/);
  for (const namespacePattern of [
    /\$_ -like 'TESSERA_\*'/,
    /\$_ -like 'CODEX_\*'/,
    /\$_ -like 'CLAUDE_\*'/,
    /\$_ -eq 'CLAUDECODE'/,
    /\$_ -like 'OPENCODE_\*'/,
  ]) {
    assert.match(launcherSource, namespacePattern);
  }
  assert.match(launcherSource, /'WSLENV',[\s\S]*'XDG_DATA_HOME'/);
  assert.match(launcherSource, /foreach \(\$name in \$clearedEnvironmentNames\)/);
  assert.match(
    launcherSource,
    /finally \{[\s\S]*SetEnvironmentVariable\(\$name, \$savedEnvironment\[\$name\], 'Process'\)/,
  );
});

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
