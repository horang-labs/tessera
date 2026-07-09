import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const telemetryProviderSource = fs.readFileSync(
  new URL('../src/components/telemetry/telemetry-provider.tsx', import.meta.url),
  'utf8',
);
const telemetryClientSource = fs.readFileSync(
  new URL('../src/lib/telemetry/client.ts', import.meta.url),
  'utf8',
);
const telemetryServerSource = fs.readFileSync(
  new URL('../src/lib/telemetry/server.ts', import.meta.url),
  'utf8',
);
const telemetryServerStateSource = fs.readFileSync(
  new URL('../src/lib/telemetry/server-state.ts', import.meta.url),
  'utf8',
);
const firstRunRouteSource = fs.readFileSync(
  new URL('../src/app/api/telemetry/first-run/route.ts', import.meta.url),
  'utf8',
);

test('browser telemetry waits for the server bootstrap install id', () => {
  // Runtime behaviour is covered in telemetry-first-run-state.test.ts. These
  // assertions guard the wiring that can only be checked at the source level:
  // the browser must never mint or persist its own install id.
  assert.doesNotMatch(telemetryProviderSource, /getTelemetryInstallId/);
  assert.doesNotMatch(telemetryProviderSource, /fallbackInstallId/);
  assert.doesNotMatch(telemetryClientSource, /getTelemetryInstallId/);
  assert.doesNotMatch(telemetryClientSource, /tessera:telemetry:install-id/);
  // Install id and host info are sourced only from the bootstrap response.
  assert.match(telemetryProviderSource, /installId = bootstrap\?\.installId \?\? null/);
  assert.match(telemetryProviderSource, /contextServerHostInfo = bootstrap\?\.serverHostInfo \?\? null/);
  // No runtime context (and therefore no capture) until an install id exists.
  assert.match(telemetryProviderSource, /!installId\)\s*return null/);
  // The allow-gate no longer depends on the settings-store host info.
  assert.doesNotMatch(telemetryProviderSource, /settingsServerHostInfo/);
});

test('first-run skip state is persisted with a reason and exposed on server telemetry', () => {
  assert.match(telemetryServerStateSource, /firstRunSkipReason: FirstRunSkipReason \| null/);
  assert.match(telemetryServerStateSource, /existing_install_data/);
  assert.match(telemetryServerStateSource, /telemetry_disabled_by_env/);
  assert.match(telemetryServerStateSource, /client_disabled/);
  assert.match(firstRunRouteSource, /skipReason/);
  assert.match(firstRunRouteSource, /normalizeFirstRunSkipReason/);
  assert.match(telemetryServerSource, /first_run_eligible: bootstrap\.firstRunEligible/);
  assert.match(telemetryServerSource, /first_run_status: getFirstRunStatus\(bootstrap\)/);
  assert.match(telemetryServerSource, /first_run_skip_reason: bootstrap\.firstRunSkipReason/);
});
