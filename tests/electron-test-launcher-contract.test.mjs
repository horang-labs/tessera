import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
