import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const runtimeHostSource = readFileSync(
  new URL('../src/lib/control/runtime-host.ts', import.meta.url),
  'utf8',
);

test('Control CLI telemetry honors opt-out and sends only static operation metadata', () => {
  assert.match(runtimeHostSource, /if \(!settings\.telemetry\.enabled\) return/);

  const capture = /captureServerTelemetryEvent\('tessera_cli_command',[\s\S]*?\);/
    .exec(runtimeHostSource)?.[0];
  assert.ok(capture, 'missing Tessera CLI telemetry capture');
  assert.match(capture, /\{ operation, result \}/);
  assert.doesNotMatch(
    capture,
    /projectId|worktreeId|sessionId|prompt|branch|path|args|argument|body|text|content/,
  );
});
