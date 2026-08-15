import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { normalizeUserSettings } from '@/lib/settings/provider-defaults';

const setupClientSource = fs.readFileSync(
  new URL('../src/components/setup/setup-client.tsx', import.meta.url),
  'utf8',
);

test('new installs enable telemetry by default while preserving a later opt-out', () => {
  assert.equal(normalizeUserSettings({}).telemetry.enabled, true);
  assert.equal(normalizeUserSettings({ telemetry: { enabled: false } }).telemetry.enabled, false);
});

test('first-run onboarding does not render a telemetry consent checkbox', () => {
  assert.doesNotMatch(setupClientSource, /SetupTelemetryConsent/);
  assert.doesNotMatch(setupClientSource, /setup-telemetry-enabled/);
});
