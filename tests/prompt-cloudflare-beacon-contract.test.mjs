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

  assert.match(helper, /captureCloudflarePromptBeacon\(properties\.provider_id\);/);
  assert.ok(
    helper.indexOf('captureCloudflarePromptBeacon(properties.provider_id);') < helper.indexOf('isTelemetryReady()'),
    'the Cloudflare beacon must not be gated by PostHog readiness or opt-out',
  );
});

test('the browser beacon and server route carry only a closed provider dimension', () => {
  const client = source('src/lib/telemetry/client.ts');
  const beacon = client.match(/function captureCloudflarePromptBeacon\(provider: unknown\)[\s\S]*?\n}\n/)?.[0] ?? '';
  const route = source('src/app/api/telemetry/prompt-beacon/route.ts');

  assert.match(beacon, /fetch\('\/api\/telemetry\/prompt-beacon', \{/);
  assert.match(beacon, /method: 'POST'/);
  assert.doesNotMatch(beacon, /body\s*:|properties|correlationKey/);
  assert.match(beacon, /'X-Tessera-Provider': normalizeTelemetryProvider\(provider\)/);
  assert.match(route, /normalizeTelemetryProvider\(req\.headers\.get\('x-tessera-provider'\)\)/);
  assert.match(route, /triggerModelConfigRefresh\('prompt', \{ provider \}\)/);
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
});
