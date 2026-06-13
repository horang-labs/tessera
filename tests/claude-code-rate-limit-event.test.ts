import assert from 'node:assert/strict';
import test from 'node:test';
import { claudeCodeProtocolParser } from '../src/lib/cli/providers/claude-code/protocol-parser';

// The Claude Code CLI (>= v2.1.x) emits a top-level `rate_limit_event` stdout
// message carrying unified usage-limit status. Tessera does not model it, so the
// active provider parser must ignore it silently rather than fall through to the
// `default` branch and surface a generic "Unhandled Claude Code message type"
// warning in the chat transcript. The ignore list previously lived only on the
// separate routeProtocolMessage path and never reached this parser.

const SESSION = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

function systemWarnings(messages: ReturnType<typeof claudeCodeProtocolParser.parseStdout>) {
  return messages.filter((m) => m.serverMessage && (m.serverMessage as any).type === 'system');
}

test('rate_limit_event is ignored, not surfaced as an unhandled-type chat warning', () => {
  const line = JSON.stringify({
    type: 'rate_limit_event',
    session_id: SESSION,
    uuid: '00000000-0000-0000-0000-000000000000',
    rate_limit_info: {
      status: 'allowed_warning',
      rateLimitType: 'five_hour',
      resetsAt: 1777980453,
    },
  });

  const result = claudeCodeProtocolParser.parseStdout(SESSION, line);

  assert.equal(
    result.length,
    0,
    `rate_limit_event must produce no parsed messages; got: ${JSON.stringify(result)}`,
  );
  assert.equal(
    systemWarnings(result).length,
    0,
    'rate_limit_event must not emit a system warning to the chat',
  );
});

test('a genuinely unknown message type still surfaces the unhandled-type warning', () => {
  const line = JSON.stringify({
    type: 'totally_unknown_future_type',
    session_id: SESSION,
    uuid: '00000000-0000-0000-0000-000000000001',
  });

  const result = claudeCodeProtocolParser.parseStdout(SESSION, line);
  const warnings = systemWarnings(result);

  assert.equal(warnings.length, 1, 'unknown types must still warn so real gaps stay visible');
  const sm = warnings[0].serverMessage as { type: string; severity: string; message: string };
  assert.equal(sm.severity, 'warning');
  assert.match(sm.message, /Unhandled Claude Code message type: totally_unknown_future_type/);
});
