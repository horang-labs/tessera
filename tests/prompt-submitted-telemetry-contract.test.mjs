import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const wsClientSource = readFileSync(new URL('../src/lib/ws/client.ts', import.meta.url), 'utf8');
test('successful chat and terminal submissions emit content-free semantic telemetry', () => {
  assert.match(
    wsClientSource,
    /captureTelemetryPromptSubmitted\(sessionId, \{[\s\S]*?source: 'gui'/,
  );
  assert.match(
    wsClientSource,
    /captureTelemetryPromptSubmitted\(terminalId, \{ source: 'pty_direct' \}\)/,
  );
  assert.match(
    wsClientSource,
    /captureTelemetryPromptSubmitted\(sessionId, \{ source: 'pty_chat_view' \}\)/,
  );

  for (const match of wsClientSource.matchAll(/captureTelemetryPromptSubmitted\([^,]+,\s*\{[\s\S]*?\}\);/g)) {
    assert.doesNotMatch(
      match[0],
      /(?:prompt|message|content|text|title|path|url)\s*:/,
      `prompt telemetry must not contain user content: ${match[0]}`,
    );
  }
});

test('prompt outcomes use only local correlation keys and coarse duration buckets', () => {
  assert.match(wsClientSource, /captureTelemetryPromptTurnFinished\(sessionId, 'cancelled'\)/);

  const telemetrySource = readFileSync(
    new URL('../src/lib/telemetry/client.ts', import.meta.url),
    'utf8',
  );
  assert.match(telemetrySource, /const pendingPromptTurns = new Map/);
  assert.match(telemetrySource, /duration_bucket: getTelemetryDurationBucket/);
  assert.doesNotMatch(telemetrySource, /pendingPromptTurns[\s\S]*?captureTelemetryEvent\([\s\S]*?(?:sessionId|terminalId)\s*:/);
});
