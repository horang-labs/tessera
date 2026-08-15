import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

function source(relativePath) {
  return readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8');
}

test('every privacy-safe prompt submission also emits the opt-out-independent beacon', () => {
  const client = source('src/lib/telemetry/client.ts');
  const helper = client.match(
    /export function captureTelemetryPromptSubmitted\([\s\S]*?\n}\n/,
  )?.[0] ?? '';

  assert.match(helper, /captureCloudflarePromptBeacon\(properties\.provider_id, properties\.source\);/);
  assert.ok(
    helper.indexOf('captureCloudflarePromptBeacon(properties.provider_id, properties.source);') < helper.indexOf('isTelemetryReady()'),
    'the Cloudflare beacon must not be gated by PostHog readiness or opt-out',
  );
});

test('the browser beacon and server route carry only closed usage dimensions', () => {
  const client = source('src/lib/telemetry/client.ts');
  const beacon = client.match(/function captureCloudflarePromptBeacon\(provider: unknown, source: unknown\)[\s\S]*?\n}\n/)?.[0] ?? '';
  const route = source('src/app/api/telemetry/prompt-beacon/route.ts');

  assert.match(beacon, /fetch\('\/api\/telemetry\/prompt-beacon', \{/);
  assert.match(beacon, /method: 'POST'/);
  assert.doesNotMatch(beacon, /body\s*:|properties|correlationKey/);
  assert.match(beacon, /'X-Tessera-Provider': normalizeTelemetryProvider\(provider\)/);
  assert.match(beacon, /'X-Tessera-Source': normalizeTelemetryPromptSource\(source\)/);
  assert.match(beacon, /'X-Tessera-Form-Factor': normalizeTelemetryFormFactor/);
  assert.match(route, /normalizeTelemetryProvider\(req\.headers\.get\('x-tessera-provider'\)\)/);
  assert.match(route, /normalizeTelemetryPromptSource\(req\.headers\.get\('x-tessera-source'\)\)/);
  assert.match(route, /normalizeTelemetryFormFactor\(req\.headers\.get\('x-tessera-form-factor'\)\)/);
  assert.match(route, /triggerModelConfigRefresh\('prompt', \{ provider, source, formFactor \}\)/);
  assert.doesNotMatch(route, /req\.(?:json|text|formData)\(|body\s*:/);
});

test('the Worker request supports a dedicated prompt event', () => {
  const remoteConfig = source('src/lib/model-config/remote-config.ts');
  assert.match(
    remoteConfig,
    /ModelConfigFetchReason = 'launch' \| 'session' \| 'prompt'/,
  );
  assert.match(remoteConfig, /'X-Tessera-Event': reason/);
  assert.match(remoteConfig, /'X-Tessera-Platform': String\(hostInfo\.platform\)/);
  assert.match(remoteConfig, /headers\['X-Tessera-Provider'\] = normalizeTelemetryProvider/);
  assert.match(remoteConfig, /headers\['X-Tessera-Source'\] = normalizeTelemetryPromptSource/);
  assert.match(remoteConfig, /headers\['X-Tessera-Form-Factor'\] = normalizeTelemetryFormFactor/);
});
