import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const wsClientSource = readFileSync(new URL('../src/lib/ws/client.ts', import.meta.url), 'utf8');

test('successful chat and terminal submissions emit content-free semantic telemetry', () => {
  assert.match(
    wsClientSource,
    /captureTelemetryEvent\('prompt_submitted', \{ source: 'chat' \}\)/,
  );
  assert.match(
    wsClientSource,
    /captureTelemetryEvent\('prompt_submitted', \{ source: 'terminal' \}\)/,
  );

  for (const match of wsClientSource.matchAll(/captureTelemetryEvent\('prompt_submitted',[\s\S]*?\);/g)) {
    assert.doesNotMatch(
      match[0],
      /content|data|message|prompt\s*:/,
      `prompt telemetry must contain only static metadata: ${match[0]}`,
    );
  }
});
