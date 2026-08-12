import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const fixtureSource = path.join(
  process.cwd(),
  'tests/fixtures/packaged-windows-wsl',
);
const packagedRunner = path.join(fixtureSource, 'run-acceptance.sh');
const canRunWslFixture = process.platform === 'linux'
  && /^\/home\/[A-Za-z0-9._-]+$/.test(os.homedir())
  && fs.existsSync('/bin/sh')
  && fs.existsSync('/usr/bin/python3')
  && fs.existsSync('/usr/bin/zsh');
const fixtureRoot = path.join(os.homedir(), '.tessera/test-fixtures', `unit-${process.pid}-${Date.now()}`);
const fixtureTest = canRunWslFixture ? test : test.skip;

if (canRunWslFixture) {
  execFileSync('sh', [path.join(fixtureSource, 'setup.sh'), fixtureRoot], {
    stdio: 'pipe',
  });
}

test.after(() => {
  if (canRunWslFixture) fs.rmSync(fixtureRoot, { recursive: true, force: true });
});

function loginEnvironment(): NodeJS.ProcessEnv {
  const env = {
    ...process.env,
    ZDOTDIR: path.join(fixtureRoot, 'shell'),
  };
  for (const name of [
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
    delete env[name];
  }
  return env;
}

function fixtureProcessEnvironment(): NodeJS.ProcessEnv {
  return {
    ...loginEnvironment(),
    TESSERA_ACCEPTANCE_FIXTURE_ROOT: fixtureRoot,
    CODEX_HOME: path.join(fixtureRoot, 'codex-home'),
    CLAUDE_CONFIG_DIR: path.join(fixtureRoot, 'claude-home'),
    XDG_CONFIG_HOME: path.join(fixtureRoot, 'xdg-config'),
    XDG_DATA_HOME: path.join(fixtureRoot, 'xdg-data'),
  };
}

function appServerRequest(
  method: string,
  params: Record<string, unknown> = {},
): Record<string, unknown> {
  const input = [
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    JSON.stringify({ jsonrpc: '2.0', id: 2, method, params }),
    '',
  ].join('\n');
  const result = spawnSync(path.join(fixtureRoot, 'bin/codex'), ['app-server'], {
    input,
    encoding: 'utf8',
    env: fixtureProcessEnvironment(),
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout.trim().split('\n').at(-1)!) as Record<string, unknown>;
}

fixtureTest('fixture login shell selects isolated WSL provider homes', () => {
  const output = execFileSync(
    'zsh',
    ['-ilc', 'printf "%s\n%s\n%s\n%s\n" "$CODEX_HOME" "$CLAUDE_CONFIG_DIR" "$XDG_CONFIG_HOME" "$XDG_DATA_HOME"'],
    { encoding: 'utf8', env: loginEnvironment() },
  ).trim().split('\n');

  assert.deepEqual(output, [
    path.join(fixtureRoot, 'codex-home'),
    path.join(fixtureRoot, 'claude-home'),
    path.join(fixtureRoot, 'xdg-config'),
    path.join(fixtureRoot, 'xdg-data'),
  ]);
  assert.equal(
    execFileSync('zsh', ['-ilc', 'codex --version'], {
      encoding: 'utf8',
      env: loginEnvironment(),
    }).trim(),
    'codex-cli 0.146.0',
  );
});

fixtureTest('fixture Codex models trust through its API and persists only synthetic provider state', () => {
  const listed = appServerRequest('hooks/list');
  const hooks = ((listed.result as { data: Array<{ hooks: Array<Record<string, unknown>> }> })
    .data[0].hooks);
  assert.ok(hooks.length >= 1);
  assert.equal(hooks.every((hook) => hook.trustStatus === 'untrusted'), true);

  const trust = Object.fromEntries(hooks.map((hook) => [
    String(hook.key),
    { trusted_hash: String(hook.currentHash) },
  ]));
  appServerRequest('config/batchWrite', {
    edits: [{ keyPath: 'hooks.state', value: trust }],
  });
  const verified = appServerRequest('hooks/list');
  const verifiedHooks = ((verified.result as {
    data: Array<{ hooks: Array<Record<string, unknown>> }>;
  }).data[0].hooks);
  assert.equal(verifiedHooks.every((hook) => hook.trustStatus === 'trusted'), true);

  appServerRequest('thread/start');
  assert.match(fs.readFileSync(path.join(fixtureRoot, 'codex-home/config.toml'), 'utf8'), /thread\/start/);
  const auth = fs.readFileSync(path.join(fixtureRoot, 'codex-home/auth.json'), 'utf8');
  assert.match(auth, /synthetic-auth/);
  assert.doesNotMatch(auth, /(?:sk-|Bearer |refresh_token|access_token)/i);
});

fixtureTest('fixture user hook runs while the Tessera hook is an external no-op', () => {
  const hooksPath = path.join(fixtureRoot, 'codex-home/hooks.json');
  const hooks = JSON.parse(fs.readFileSync(hooksPath, 'utf8')) as {
    hooks: { SessionStart: Array<{ hooks: Array<Record<string, unknown>> }> };
  };
  hooks.hooks.SessionStart.push({ hooks: [{
    type: 'command',
    timeout: 10,
    command: 'if [ -n "${TESSERA_CLI_COMMAND:-}" ]; then printf "%s\\n" contacted >> "$TESSERA_ACCEPTANCE_FIXTURE_ROOT/evidence/tessera-external.log"; fi',
  }] });
  fs.writeFileSync(hooksPath, `${JSON.stringify(hooks, null, 2)}\n`);

  const result = spawnSync(path.join(fixtureRoot, 'bin/codex'), ['acceptance-external'], {
    encoding: 'utf8',
    env: fixtureProcessEnvironment(),
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    fs.readFileSync(path.join(fixtureRoot, 'evidence/user-hook.log'), 'utf8'),
    'user-hook\n',
  );
  const external = fs.readFileSync(path.join(fixtureRoot, 'evidence/external.jsonl'), 'utf8');
  assert.match(external, /"managed": false/);
  assert.equal(fs.existsSync(path.join(fixtureRoot, 'evidence/tessera-external.log')), false);
});

fixtureTest('packaged runner composes every production-topology acceptance seam', () => {
  const help = execFileSync('bash', [packagedRunner, '--help'], { encoding: 'utf8' });
  assert.match(help, /packaged Windows Electron parent\/backend with\s+a WSL provider fixture/);
  const source = fs.readFileSync(packagedRunner, 'utf8');
  for (const seam of [
    'configure',
    'install',
    'start',
    'acceptance-external',
    'stop-for-restart',
    'restart-status',
    'legacy-provider-349',
    'derived-provider-349',
    'hook-api-unavailable',
    'terminal-create-blocked',
    'control-ran.json',
    '-RemoveData',
    'New-Item -ItemType Directory -Path $root -ErrorAction Stop',
    'remove_owned_test_root',
    'cleanupComplete',
  ]) {
    assert.match(source, new RegExp(seam.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.match(source, /\[\[ \$before_installed == "\$after_installed" \]\]/);
  assert.match(source, /\[\[ \$before_hashes == "\$after_hashes" \]\]/);
});
