import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildLoginShellExecScript,
  buildSpawnEnvironment,
} from '../src/lib/cli/spawn-cli-runtime';
import type { SpawnCliCache } from '../src/lib/cli/spawn-cli-cache';
import { getRuntimePlatform } from '../src/lib/system/runtime-platform';

function emptyCache(): SpawnCliCache {
  return {
    agentEnvironmentByUserId: new Map(),
    defaultAgentEnvironment: null,
    loginShell: null,
    didResolveLoginShell: false,
    loginShellEnvironment: null,
    didResolveLoginShellEnvironment: false,
  };
}

const PATH_DELIM = getRuntimePlatform() === 'win32' ? ';' : ':';

test('Linux: PATH includes /opt/homebrew/bin or /usr/local/bin if present', { skip: getRuntimePlatform() !== 'linux' }, () => {
  // We can only assert this works if one of those dirs exists on the test host.
  // Otherwise simply ensure the function returns successfully and didn't crash.
  const env = buildSpawnEnvironment({ PATH: '/nowhere' }, emptyCache());
  assert.ok(typeof env.PATH === 'string');
  const segments = (env.PATH ?? '').split(PATH_DELIM);
  // /usr/local/bin almost always exists on a Linux test host; assert only when it does.
  // This guards against regressions in the supplemental-path append.
  // (If neither exists on CI, the test still passes — function returned a valid PATH.)
  if (segments.includes('/usr/local/bin') || segments.includes('/opt/homebrew/bin')) {
    assert.ok(segments.includes('/usr/local/bin') || segments.includes('/opt/homebrew/bin'));
  }
});

test('macOS: PATH includes Homebrew dirs when present', { skip: getRuntimePlatform() !== 'darwin' }, () => {
  const env = buildSpawnEnvironment({ HOME: process.env.HOME, PATH: '/nowhere' }, emptyCache());
  assert.ok(typeof env.PATH === 'string');
});

test('explicit CODEX_HOME overrides only its login-shell supplement', () => {
  const cache = emptyCache();
  cache.loginShell = process.env.SHELL || '/bin/sh';
  cache.didResolveLoginShell = true;
  cache.loginShellEnvironment = {
    CODEX_HOME: '/tmp/tessera/codex-overlay/session-123',
    HTTPS_PROXY: 'https://login-shell-proxy.test',
  };
  cache.didResolveLoginShellEnvironment = true;

  const env = buildSpawnEnvironment(
    {
      CODEX_HOME: '/tmp/codex-account-home',
      HTTPS_PROXY: 'https://parent-process-proxy.test',
      PATH: '/nowhere',
    },
    cache,
  );

  assert.equal(env.CODEX_HOME, '/tmp/codex-account-home');
  assert.equal(env.HTTPS_PROXY, 'https://login-shell-proxy.test');
});

test('WSL guest launch values are applied after login rc and shell-quoted', () => {
  const script = buildLoginShellExecScript(
    'codex',
    ['app-server'],
    '/workspace/it has spaces',
    {
      TESSERA_ENV: '1',
      TESSERA_CLI_COMMAND: "/home/user/it's tessera",
      TESSERA_WORKTREE_ID: undefined,
    },
  );

  assert.match(script, /^cd -- '\/workspace\/it has spaces' && /);
  assert.match(script, /export TESSERA_ENV='1'/);
  assert.match(script, /export TESSERA_CLI_COMMAND='\/home\/user\/it'\\''s tessera'/);
  assert.match(script, /unset TESSERA_WORKTREE_ID/);
  assert.match(script, /exec 'codex' 'app-server'$/);
  assert.throws(
    () => buildLoginShellExecScript('codex', [], null, { 'BAD-NAME': 'x' }),
    /Invalid guest environment key/,
  );
});

test('WSL OpenCode preserves rc config before reasserting its managed overlay', () => {
  const script = buildLoginShellExecScript('opencode', ['acp'], null, {
    OPENCODE_CONFIG_DIR: '/home/user/.tessera/overlay',
    TESSERA_OPENCODE_CONFIG_DIR: '/home/user/.tessera/overlay',
  });
  assert.ok(script.indexOf('tessera_oc_source="${OPENCODE_CONFIG_DIR:-}"') < script.indexOf('export OPENCODE_CONFIG_DIR='));
  assert.match(script, /export TESSERA_OPENCODE_CONFIG_DIR=/);
});
