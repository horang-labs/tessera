import assert from 'node:assert/strict';
import { execFile, execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

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
const windowsPowerShellPath = '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';
const canRunWindowsPowerShell = Boolean(
  process.env.WSL_DISTRO_NAME
  && fs.existsSync(windowsPowerShellPath),
);
const execFileAsync = promisify(execFile);

function launchEnvironmentHarnessArguments(mode) {
  const harnessPath = fileURLToPath(
    new URL('./fixtures/electron-launch-environment-harness.ps1', import.meta.url),
  );
  const launcherPath = fileURLToPath(
    new URL('../scripts/launch-electron-test-instances.ps1', import.meta.url),
  );
  const stopperPath = fileURLToPath(
    new URL('../scripts/stop-electron-test-session.ps1', import.meta.url),
  );
  const toWindowsPath = (value) => execFileSync('wslpath', ['-w', value], {
    encoding: 'utf8',
  }).trim();
  return [
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-File', toWindowsPath(harnessPath),
    '-Launcher', toWindowsPath(launcherPath),
    '-Stopper', toWindowsPath(stopperPath),
    '-Mode', mode,
  ];
}

function runLaunchEnvironmentHarness(mode) {
  const stdout = execFileSync(windowsPowerShellPath, launchEnvironmentHarnessArguments(mode), {
    encoding: 'utf8',
    timeout: 30_000,
  });
  return JSON.parse(stdout);
}

async function runLaunchEnvironmentHarnessAsync(mode) {
  const { stdout } = await execFileAsync(
    windowsPowerShellPath,
    launchEnvironmentHarnessArguments(mode),
    { encoding: 'utf8', timeout: 30_000 },
  );
  return JSON.parse(stdout);
}

function assertHarnessCleanup(result) {
  assert.equal(result.cleanupError, null);
  assert.equal(result.remainingWslStateRoots.length, 0);
  for (const root of result.wslStateRoots) {
    assert.equal(fs.existsSync(root), false, `launcher-owned WSL state remained: ${root}`);
  }
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
  assert.match(result.sessionId, /^env-contract-t355-/);
  assert.equal(result.launches.length, 2);
  for (const [index, launch] of result.launches.entries()) {
    assertHostileEnvironmentCleared(result, launch, `into launch ${index + 1}`);
    assert.equal(
      launch.environment.TESSERA_ELECTRON_TEST_INSTANCE,
      `${result.sessionId}-${index + 1}`,
    );
    assert.equal(launch.environment.TESSERA_ELECTRON_TEST_ROOT.endsWith('tessera-launch-env-'), false);
    assert.match(launch.environment.TESSERA_ELECTRON_TEST_ROOT, /tessera-launch-env-[a-f0-9]{32}$/);
    assert.match(launch.environment.TESSERA_ELECTRON_TEST_SERVER_PORT, /^\d+$/);
    assert.equal(launch.environment.WSL_DISTRO_NAME, 'Ubuntu-24.04');
  }
  assert.deepEqual(result.restoredEnvironment, expectedRestoredEnvironment(result));
  assertHarnessCleanup(result);
});

test('isolated Electron launcher restores caller environment when child launch fails', {
  skip: !canRunWindowsPowerShell,
}, () => {
  const result = runLaunchEnvironmentHarness('Failure');

  assert.match(result.launchError, /Synthetic Start-Process failure/);
  assert.equal(result.launches.length, 1);
  assertHostileEnvironmentCleared(result, result.launches[0], 'before failure');
  assert.deepEqual(result.restoredEnvironment, expectedRestoredEnvironment(result));
  assertHarnessCleanup(result);
});

test('launcher cleanup fails closed without changing a mismatched WSL owner marker', {
  skip: !canRunWindowsPowerShell,
}, () => {
  const result = runLaunchEnvironmentHarness('MismatchedOwner');

  assert.match(result.cleanupError, /Refusing to remove non-owned WSL fixture root/);
  assert.equal(result.mismatchedMarkerPreserved, true);
  assert.equal(result.cleanupFailurePreservedRoots, true);
  assert.equal(result.finalCleanupError, null);
  assert.equal(result.remainingWslStateRoots.length, 0);
  for (const root of result.wslStateRoots) {
    assert.equal(fs.existsSync(root), false, `restored owner cleanup left WSL state: ${root}`);
  }
});

test('a retained schema-3 manifest without portableArtifact restarts with the same owner', {
  skip: !canRunWindowsPowerShell,
}, () => {
  const result = runLaunchEnvironmentHarness('LegacyRestart');

  assert.equal(result.launchError, null);
  assert.equal(result.legacyRestartSucceeded, true);
  assert.equal(result.restartOwnerTokenPreserved, true);
  assert.equal(result.launches.length, 2);
  assertHarnessCleanup(result);
});

test('final cleanup without a recorded portable artifact fails before removing state', {
  skip: !canRunWindowsPowerShell,
}, () => {
  const result = runLaunchEnvironmentHarness('MissingArtifact');

  assert.match(result.cleanupError, /portable artifact that was not recorded by the launcher/);
  assert.equal(result.cleanupFailurePreservedRoots, true);
  assert.equal(result.finalCleanupError, null);
  assert.equal(result.remainingWslStateRoots.length, 0);
  for (const root of result.wslStateRoots) {
    assert.equal(fs.existsSync(root), false, `final cleanup left WSL state: ${root}`);
  }
});

test('parallel launcher contract harnesses use collision-free owned namespaces', {
  skip: !canRunWindowsPowerShell,
}, async () => {
  const results = await Promise.all([
    runLaunchEnvironmentHarnessAsync('Success'),
    runLaunchEnvironmentHarnessAsync('Success'),
  ]);

  assert.notEqual(results[0].sessionId, results[1].sessionId);
  for (const result of results) {
    assertHarnessCleanup(result);
  }
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
  assert.match(launcherSource, /'WSLENV'/);
  assert.match(launcherSource, /'XDG_DATA_HOME'/);
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

test('isolated WSL provider fixtures scrub inherited authority and are manifest-owned', () => {
  for (const inheritedName of [
    'CODEX_HOME',
    'TESSERA_CODEX_HOME',
    'TESSERA_CLI_COMMAND',
    'TESSERA_PROJECT_ID',
    'TESSERA_WORKTREE_ID',
    'TESSERA_SESSION_ID',
    'TESSERA_PANE_TOKEN',
    'TESSERA_HOOK_PORT',
    'CLAUDE_CONFIG_DIR',
    'XDG_CONFIG_HOME',
    'XDG_DATA_HOME',
  ]) {
    assert.match(
      launcherSource,
      new RegExp(`'${inheritedName}'`),
      `${inheritedName} must be included in the launcher environment guard`,
    );
  }
  assert.match(launcherSource, /TESSERA_ELECTRON_TEST_WSL_FIXTURE_ROOT/);
  assert.match(launcherSource, /\.tessera[\\/]test-fixtures/);
  assert.match(launcherSource, /ZDOTDIR/);
  assert.match(launcherSource, /wslFixtureRoot = \$wslFixtureRoot/);
  assert.match(launcherSource, /wslFixtureOwnerToken = \$result\.ownerToken/);
  assert.match(launcherSource, /wslStateRoot = Get-WslTestStateRoot/);
  assert.match(launcherSource, /wslStateOwnerToken = \$result\.ownerToken/);
  assert.match(stopSource, /wslFixtureRoot/);
  assert.match(stopSource, /wslFixtureOwnerToken/);
  assert.match(stopSource, /Refusing to remove non-owned WSL fixture root/);
  assert.match(stopSource, /wslStateRoot/);
  assert.match(stopSource, /wslStateOwnerToken/);
  assert.match(stopSource, /IFS= read -r recorded/);
  assert.match(stopSource, /\[ \$\(wc -c < \$marker\) -eq 33 \]/);
  assert.match(stopSource, /\[ \$\{#recorded\} -eq 32 \]/);
  assert.match(stopSource, /case \$recorded in \*\[!A-Fa-f0-9\]\*\)/);
  assert.match(stopSource, /case \$recorded in \$token\)/);
  assert.match(stopSource, /wsl\.exe --distribution \$Distro --exec sh -c \$script tessera-fixture \$Root \$OwnerToken/);
});

test('WSL state ownership is restartable by its owner and rejects a colliding owner', (t) => {
  if (process.platform !== 'linux' || !/^\/home\/[A-Za-z0-9._-]+$/.test(os.homedir())) {
    t.skip('WSL ownership shell contract requires a Linux /home directory');
    return;
  }
  const functionStart = launcherSource.indexOf('function Initialize-WslTestStateOwnership');
  const functionEnd = launcherSource.indexOf('function Get-IsolatedWslEnvironment', functionStart);
  const functionSource = launcherSource.slice(functionStart, functionEnd);
  const shellScript = functionSource.match(/\$script = '([^']+)'/)?.[1];
  assert.ok(shellScript, 'state ownership shell script must remain discoverable');
  const root = path.join(
    os.homedir(),
    '.tessera/test-instances',
    `ownership-${process.pid}-${Date.now()}`,
  );
  assert.doesNotMatch(shellScript, /["'\\]|dirname|printf/);
  const invoke = (token) => spawnSync('powershell.exe', [
    '-NoProfile',
    '-Command',
    '& wsl.exe --distribution Ubuntu-24.04 --exec sh -c $env:OWNERSHIP_SCRIPT tessera-state $env:OWNERSHIP_ROOT $env:OWNERSHIP_TOKEN; exit $LASTEXITCODE',
  ], {
    encoding: 'utf8',
    env: {
      ...process.env,
      OWNERSHIP_SCRIPT: shellScript,
      OWNERSHIP_ROOT: root,
      OWNERSHIP_TOKEN: token,
      WSLENV: `OWNERSHIP_SCRIPT:OWNERSHIP_ROOT:OWNERSHIP_TOKEN:${process.env.WSLENV ?? ''}`,
    },
  });
  const ownerA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const ownerB = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  try {
    assert.equal(invoke(ownerA).status, 0);
    assert.equal(invoke(ownerA).status, 0, 'the recorded owner may restart');
    assert.notEqual(invoke(ownerB).status, 0, 'a colliding owner must fail closed');
    fs.writeFileSync(path.join(root, '.tessera-owner'), 'x = x -o y\n');
    assert.notEqual(invoke(ownerB).status, 0, 'a shell-expression marker must fail closed');
    fs.writeFileSync(path.join(root, '.tessera-owner'), `${ownerA}\nextra\n`);
    assert.notEqual(invoke(ownerA).status, 0, 'a multiline marker must fail closed');
    fs.writeFileSync(path.join(root, '.tessera-owner'), `${ownerA}\nunterminated-tail`);
    assert.notEqual(invoke(ownerA).status, 0, 'an unterminated marker tail must fail closed');
    fs.writeFileSync(path.join(root, '.tessera-owner'), `${ownerA}\n`);
    assert.equal(fs.readFileSync(path.join(root, '.tessera-owner'), 'utf8'), `${ownerA}\n`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('WSL home discovery survives the PowerShell 5.1 native argv binder', () => {
  const match = launcherSource.match(/\$homeScript = '([^']+)'/);
  assert.ok(match);
  assert.doesNotMatch(match[1], /["'\\]|printf/);
  const result = spawnSync('powershell.exe', [
    '-NoProfile',
    '-Command',
    '& wsl.exe --distribution Ubuntu-24.04 --exec sh -c $env:HOME_SCRIPT; exit $LASTEXITCODE',
  ], {
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME_SCRIPT: match[1],
      WSLENV: `HOME_SCRIPT:${process.env.WSLENV ?? ''}`,
    },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout.trim(), /^\/home\/[A-Za-z0-9._-]+$/);
});

test('stopping without data removal preserves restart authority until final cleanup', () => {
  assert.match(stopSource, /if \(\$RemoveData\) \{\s*Remove-Item -LiteralPath \$manifestPath -Force\s*\}/);
  assert.match(launcherSource, /\$restartInstance\.wslStateOwnerToken -ne \$ownerToken/);
  assert.match(launcherSource, /\$restartInstance\.wslFixtureOwnerToken -ne \$ownerToken/);
  assert.match(launcherSource, /Restart must reuse the exact retained Electron test instance set/);
  assert.match(launcherSource, /\[string\]::IsNullOrWhiteSpace\(\[string\]\$existingManifest\.portableArtifact\)/);
  assert.match(launcherSource, /\[string\]::IsNullOrWhiteSpace\(\$PortableArtifact\)/);
  assert.match(launcherSource, /\$existingPortableArtifact -eq \$requestedPortableArtifact/);
});

test('PowerShell isolation policies expand to flat environment-name sets', (t) => {
  if (spawnSync('powershell.exe', ['-NoProfile', '-Command', 'exit 0']).status !== 0) {
    t.skip('PowerShell interop is unavailable');
    return;
  }
  const start = launcherSource.indexOf('$providerAuthorityEnvironmentNames = @(');
  const end = launcherSource.indexOf('function Get-IsolatedWslEnvironment', start);
  assert.ok(start >= 0 && end > start);
  const declarations = launcherSource.slice(start, end);
  const command = `${declarations}\n[pscustomobject]@{ authority=$providerAuthorityEnvironmentNames; scrub=$launchScrubEnvironmentNames; blocked=$wslPropagationBlockedNames } | ConvertTo-Json -Compress -Depth 4`;
  const evaluated = spawnSync('powershell.exe', ['-NoProfile', '-Command', command], {
    encoding: 'utf8',
  });
  assert.equal(evaluated.status, 0, evaluated.stderr);
  const policies = JSON.parse(evaluated.stdout.trim());
  for (const [name, entries] of Object.entries(policies)) {
    assert.equal(entries.every((entry) => typeof entry === 'string'), true, `${name} must be flat`);
  }
  for (const authorityName of [
    'CODEX_HOME',
    'TESSERA_CLI_COMMAND',
    'TESSERA_PROJECT_ID',
    'TESSERA_WORKTREE_ID',
    'TESSERA_SESSION_ID',
    'TESSERA_PANE_TOKEN',
    'TESSERA_HOOK_PORT',
    'CLAUDE_CONFIG_DIR',
    'XDG_CONFIG_HOME',
    'XDG_DATA_HOME',
  ]) {
    assert.ok(policies.authority.includes(authorityName));
    assert.ok(policies.scrub.includes(authorityName));
    assert.ok(policies.blocked.includes(authorityName));
  }
});

test('owned Downloads artifacts can be permanently removed without the Linux trash', () => {
  assert.match(launcherSource, /portableArtifact = \$PortableArtifactPath/);
  assert.match(stopSource, /\[switch\]\$RemoveBuildArtifacts/);
  assert.match(stopSource, /if \(\$RemoveBuildArtifacts -and -not \$RemoveData\)/);
  assert.match(stopSource, /\$manifest\.portableArtifact/);
  assert.match(stopSource, /portable artifact that was not recorded by the launcher/);
  assert.doesNotMatch(stopSource, /portableBaseName/);
  assert.match(stopSource, /GetFolderPath\('UserProfile'\)/);
  assert.match(stopSource, /Test-PathWithinRoot -Path \$appDirectory -Root \$downloads/);
  assert.match(stopSource, /Refusing to remove a nested build directory/);
  assert.match(stopSource, /Remove-PathWithRetry -Path \$buildArtifactPaths\.AppDirectory/);
  assert.match(stopSource, /Remove-PathWithRetry -Path \$buildArtifactPaths\.PortableArtifact/);
  assert.doesNotMatch(stopSource, /gio\s+trash/i);
});

test('test window titles stay identifiable after renderer page-title updates', () => {
  assert.match(electronMainSource, /resolveElectronWindowTitle\('Tessera', electronTestInstance\)/);
  assert.match(electronMainSource, /resolveElectronWindowTitle\('Tessera Board', electronTestInstance\)/);
  assert.match(electronMainSource, /webContents\.on\('page-title-updated'/);
  assert.match(electronMainSource, /event\.preventDefault\(\)/);
  assert.match(electronMainSource, /win\.setTitle\(title\)/);
});
