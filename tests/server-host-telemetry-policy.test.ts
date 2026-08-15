import assert from 'node:assert/strict';
import test from 'node:test';
import { getServerHostInfo } from '../src/lib/system/server-host.ts';

function hostInfo(env: NodeJS.ProcessEnv) {
  return getServerHostInfo({
    env,
    platform: 'win32',
    arch: 'x64',
    isWsl: false,
  });
}

test('local development disables telemetry unless explicitly enabled for telemetry testing', () => {
  assert.equal(hostInfo({ NODE_ENV: 'development' }).telemetryDisabledByEnv, true);
  assert.equal(hostInfo({
    NODE_ENV: 'development',
    TESSERA_TELEMETRY_LOCAL: '1',
  }).telemetryDisabledByEnv, false);
});

test('an Electron test instance always disables telemetry', () => {
  assert.equal(hostInfo({
    NODE_ENV: 'production',
    TESSERA_ELECTRON_SERVER: '1',
    TESSERA_ELECTRON_TEST_INSTANCE: 'codex-local-test',
    TESSERA_TELEMETRY_LOCAL: '1',
  }).telemetryDisabledByEnv, true);
});

test('a build-stamped runtime telemetry flag disables production telemetry', () => {
  assert.equal(hostInfo({
    NODE_ENV: 'production',
    TESSERA_ELECTRON_SERVER: '1',
    TESSERA_TELEMETRY_DISABLED: '1',
  }).telemetryDisabledByEnv, true);
});

test('a normal packaged production runtime remains telemetry eligible', () => {
  assert.equal(hostInfo({
    NODE_ENV: 'production',
    TESSERA_ELECTRON_SERVER: '1',
  }).telemetryDisabledByEnv, false);
});
