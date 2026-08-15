import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

function source(relativePath) {
  return readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8');
}

test('debug package scripts strip PostHog and stamp runtime telemetry disabled', () => {
  const packageJson = JSON.parse(source('package.json'));
  for (const scriptName of [
    'electron:build:win:debug',
    'electron:build:linux:debug',
    'electron:build:mac-x64:debug',
    'electron:build:mac-arm64:debug',
  ]) {
    const script = packageJson.scripts[scriptName];
    assert.match(script, /TESSERA_TELEMETRY_DISABLED=1/);
    assert.match(script, /extraMetadata\.tesseraTelemetryDisabled=true/);
  }

  const nextConfig = source('next.config.mjs');
  assert.match(nextConfig, /telemetryBuildDisabled = process\.env\.TESSERA_TELEMETRY_DISABLED === '1'/);
  assert.match(nextConfig, /!telemetryBuildDisabled[\s\S]*process\.env\.NODE_ENV !== 'development'/);
});

test('Electron propagates build-stamped telemetry disablement to its server child', () => {
  const electronMain = source('electron/main.ts');
  assert.match(electronMain, /tesseraTelemetryDisabled\?: unknown/);
  assert.match(
    electronMain,
    /BUILD_STAMPED_TELEMETRY_DISABLED = BUILD_METADATA\.tesseraTelemetryDisabled === true/,
  );
  assert.match(
    electronMain,
    /BUILD_STAMPED_TELEMETRY_DISABLED \? \{ TESSERA_TELEMETRY_DISABLED: '1' \} : \{\}/,
  );
});

test('the Electron dev launcher marks every isolated runtime as a test instance', () => {
  const launcher = source('scripts/launch-electron-test-instances.ps1');
  const serverHost = source('src/lib/system/server-host.ts');
  assert.match(launcher, /\$env:TESSERA_ELECTRON_TEST_INSTANCE = \$instanceId/);
  assert.match(serverHost, /env\.TESSERA_ELECTRON_TEST_INSTANCE\?\.trim\(\)/);
});
