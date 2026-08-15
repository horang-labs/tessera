import assert from 'node:assert/strict';
import test from 'node:test';
import { claudeCodeProtocolParser } from '../src/lib/cli/providers/claude-code/protocol-parser';
import {
  COMPACT_PROGRESS_MAX_PERCENT,
  COMPACT_PROGRESS_TIME_CONSTANT_MS,
  computeCompactProgressPercent,
} from '../src/lib/chat/compact-progress';

// Compaction is the one long phase where the CLI stops emitting anything the
// chat can render. It is bracketed by `{"subtype":"status","status":"compacting"}`
// and a closing `{"subtype":"status","status":null}` that carries the outcome —
// the frames below are verbatim from `claude --print --output-format stream-json`
// runs (a manual /compact that succeeded, and one rejected for having too few
// messages). Nothing in between reports progress, which is why the docked bar is
// driven by elapsed time.

const SESSION = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

function systemMessages(line: string) {
  return claudeCodeProtocolParser
    .parseStdout(SESSION, line)
    .map((m) => m.serverMessage as any)
    .filter((m) => m?.type === 'system');
}

test('the opening status frame is surfaced with the compacting phase in metadata', () => {
  const [message] = systemMessages(JSON.stringify({
    type: 'system',
    subtype: 'status',
    status: 'compacting',
    session_id: SESSION,
    uuid: '11111111-1111-1111-1111-111111111111',
  }));

  assert.ok(message, 'expected a system message for the opening status frame');
  assert.equal(message.subtype, 'status');
  assert.equal(message.metadata?.status, 'compacting');
  // Silent in the transcript — it drives the docked bar, not a chat bubble.
  assert.equal(message.severity, 'info');
});

test('the closing status frame reports success and clears the phase', () => {
  const [message] = systemMessages(JSON.stringify({
    type: 'system',
    subtype: 'status',
    status: null,
    compact_result: 'success',
    session_id: SESSION,
    uuid: '22222222-2222-2222-2222-222222222222',
  }));

  assert.ok(message, 'expected a system message for the closing status frame');
  assert.equal(message.metadata?.status, null);
  assert.equal(message.metadata?.compactResult, 'success');
  assert.equal(message.severity, 'info');
});

test('a failed compaction surfaces the CLI error as a visible error message', () => {
  const [message] = systemMessages(JSON.stringify({
    type: 'system',
    subtype: 'status',
    status: null,
    compact_result: 'failed',
    compact_error: 'Not enough messages to compact.',
    session_id: SESSION,
    uuid: '33333333-3333-3333-3333-333333333333',
  }));

  assert.ok(message, 'expected a system message for the failure frame');
  assert.equal(message.metadata?.compactResult, 'failed');
  assert.equal(message.metadata?.compactError, 'Not enough messages to compact.');
  assert.match(message.message, /Not enough messages to compact\./);
  // Error severity is what gets it past the transcript's info-level filter.
  assert.equal(message.severity, 'error');
});

test('unrelated status phases carry no compaction outcome', () => {
  const [message] = systemMessages(JSON.stringify({
    type: 'system',
    subtype: 'status',
    status: 'requesting',
    session_id: SESSION,
    uuid: '44444444-4444-4444-4444-444444444444',
  }));

  assert.ok(message, 'expected a system message for the requesting frame');
  assert.equal(message.metadata?.status, 'requesting');
  assert.equal(message.metadata?.compactResult, undefined);
});

test('progress follows the CLI curve and never claims completion', () => {
  assert.equal(computeCompactProgressPercent(0), 0);

  // The value in the terminal screenshot this was modelled on: ~3.7s in.
  assert.equal(computeCompactProgressPercent(3_700), 4);

  // One time constant is 1 - 1/e.
  assert.equal(computeCompactProgressPercent(COMPACT_PROGRESS_TIME_CONSTANT_MS), 63);

  // A measured 13s compaction only ever reaches the mid-teens before the bar
  // disappears, which is the intended behaviour, not a stuck bar.
  assert.equal(computeCompactProgressPercent(13_013), 13);

  assert.equal(computeCompactProgressPercent(60 * 60_000), COMPACT_PROGRESS_MAX_PERCENT);
  assert.equal(computeCompactProgressPercent(-5_000), 0);
});

test('progress is monotonic across the whole range', () => {
  let previous = -1;
  for (let elapsed = 0; elapsed <= 20 * 60_000; elapsed += 500) {
    const percent = computeCompactProgressPercent(elapsed);
    assert.ok(percent >= previous, `percent went backwards at ${elapsed}ms`);
    previous = percent;
  }
});
