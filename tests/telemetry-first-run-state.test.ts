import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  getTelemetryBootstrapInfo,
  markTelemetryFirstRun,
  readTelemetryInstallState,
} from '../src/lib/telemetry/server-state';
import type { ServerHostInfo } from '../src/lib/system/types';

// Each test gets an isolated data dir so telemetry.json state never leaks
// between cases. getTesseraDataDir() reads process.env.TESSERA_DATA_DIR on
// every call, so pointing it at a fresh temp dir fully isolates the fixture.
function useTempDataDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tessera-telemetry-'));
  process.env.TESSERA_DATA_DIR = dir;
  return dir;
}

function hostInfo(overrides: Partial<ServerHostInfo> = {}): ServerHostInfo {
  return {
    appVersion: '1.2.3',
    platform: 'darwin',
    arch: 'arm64',
    channel: 'stable',
    telemetryDisabledByEnv: false,
    ...overrides,
  } as ServerHostInfo;
}

test('skip disposition persists the reason it was skipped', async () => {
  useTempDataDir();

  const state = await markTelemetryFirstRun('skipped', { skipReason: 'client_disabled' });

  assert.equal(state.firstRunSkippedAt !== null, true);
  assert.equal(state.firstRunCapturedAt, null);
  assert.equal(state.firstRunSkipReason, 'client_disabled');

  const persisted = await readTelemetryInstallState();
  assert.equal(persisted?.firstRunSkipReason, 'client_disabled');
});

test('skip without an explicit reason falls back to "unknown"', async () => {
  useTempDataDir();

  const state = await markTelemetryFirstRun('skipped');

  assert.equal(state.firstRunSkipReason, 'unknown');
});

test('capture disposition records no skip reason', async () => {
  useTempDataDir();

  const state = await markTelemetryFirstRun('captured');

  assert.equal(state.firstRunCapturedAt !== null, true);
  assert.equal(state.firstRunSkippedAt, null);
  assert.equal(state.firstRunSkipReason, null);
});

test('first-run disposition is write-once: a later call cannot overwrite it', async () => {
  useTempDataDir();

  const first = await markTelemetryFirstRun('skipped', { skipReason: 'existing_install_data' });
  const second = await markTelemetryFirstRun('captured');

  // The second call must be a no-op and return the already-committed state.
  assert.equal(second.firstRunCapturedAt, null);
  assert.equal(second.firstRunSkippedAt, first.firstRunSkippedAt);
  assert.equal(second.firstRunSkipReason, 'existing_install_data');
});

test('bootstrap on a fresh install is eligible for first-run capture', async () => {
  useTempDataDir();

  const bootstrap = await getTelemetryBootstrapInfo(hostInfo());

  assert.equal(bootstrap.firstRunEligible, true);
  assert.equal(bootstrap.firstRunSkippedAt, null);
  assert.equal(bootstrap.firstRunSkipReason, null);
  assert.equal(typeof bootstrap.installId, 'string');
});

test('bootstrap with telemetry disabled by env skips with the env reason', async () => {
  useTempDataDir();

  const bootstrap = await getTelemetryBootstrapInfo(hostInfo({ telemetryDisabledByEnv: true }));

  assert.equal(bootstrap.firstRunEligible, false);
  assert.equal(bootstrap.firstRunSkippedAt !== null, true);
  assert.equal(bootstrap.firstRunSkipReason, 'telemetry_disabled_by_env');
});

test('normalize drops legacy state without a skip reason and keeps other fields', async () => {
  const dir = useTempDataDir();
  // Simulate a telemetry.json written before firstRunSkipReason existed.
  const legacy = {
    installId: 'legacy-install-id',
    firstRunCapturedAt: null,
    firstRunSkippedAt: '2024-01-01T00:00:00.000Z',
  };
  await fsp.writeFile(path.join(dir, 'telemetry.json'), JSON.stringify(legacy), 'utf8');

  const state = await readTelemetryInstallState();

  assert.equal(state?.installId, 'legacy-install-id');
  assert.equal(state?.firstRunSkippedAt, '2024-01-01T00:00:00.000Z');
  assert.equal(state?.firstRunSkipReason, null);
});

test('normalize rejects an unrecognized skip reason', async () => {
  const dir = useTempDataDir();
  const tampered = {
    installId: 'install-id',
    firstRunCapturedAt: null,
    firstRunSkippedAt: '2024-01-01T00:00:00.000Z',
    firstRunSkipReason: 'not_a_real_reason',
  };
  await fsp.writeFile(path.join(dir, 'telemetry.json'), JSON.stringify(tampered), 'utf8');

  const state = await readTelemetryInstallState();

  assert.equal(state?.firstRunSkipReason, null);
});
