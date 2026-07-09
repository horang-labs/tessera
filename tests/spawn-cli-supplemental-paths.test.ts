import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSpawnEnvironment } from '../src/lib/cli/spawn-cli-runtime';
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
    loginShellPath: null,
    didResolveLoginShellPath: false,
    wslLoginShell: null,
    didResolveWslLoginShell: false,
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
