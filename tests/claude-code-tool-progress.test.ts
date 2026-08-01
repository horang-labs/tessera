import assert from 'node:assert/strict';
import test from 'node:test';
import { claudeCodeProtocolParser } from '../src/lib/cli/providers/claude-code/protocol-parser';

// The Claude Code CLI (>= 2.1.x) emits top-level `tool_progress` stdout
// messages while a tool call is in flight — bash/powershell output ticks,
// 30s `tool_heartbeat`s for any long tool, and REPL/subagent-retry variants.
// They carry no result content, only liveness (elapsed_time_seconds, optional
// task_id / heartbeat), so the parser must forward them as a lightweight
// live-only `tool_progress` server message — never as the generic
// "Unhandled Claude Code message type" chat warning.

const SESSION = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

function systemWarnings(messages: ReturnType<typeof claudeCodeProtocolParser.parseStdout>) {
  return messages.filter((m) => m.serverMessage && (m.serverMessage as any).type === 'system');
}

test('tool_progress (bash tick) is forwarded as a live tool_progress message', () => {
  const line = JSON.stringify({
    type: 'tool_progress',
    tool_use_id: 'toolu_0123456789abcdef',
    tool_name: 'Bash',
    parent_tool_use_id: null,
    elapsed_time_seconds: 42,
    task_id: 'bash-0gf3v8wf',
    session_id: SESSION,
    uuid: '00000000-0000-0000-0000-000000000002',
  });

  const result = claudeCodeProtocolParser.parseStdout(SESSION, line);

  assert.equal(systemWarnings(result).length, 0, 'tool_progress must not warn to the chat');
  assert.equal(result.length, 1);

  const sm = result[0].serverMessage as any;
  assert.equal(sm.type, 'tool_progress');
  assert.equal(sm.sessionId, SESSION);
  assert.equal(sm.toolUseId, 'toolu_0123456789abcdef');
  assert.equal(sm.toolName, 'Bash');
  assert.equal(sm.elapsedTimeSeconds, 42);
  assert.equal(sm.taskId, 'bash-0gf3v8wf');
  assert.equal(sm.heartbeat, undefined);
  assert.equal(typeof sm.timestamp, 'string');
});

test('tool_progress (heartbeat) propagates the heartbeat flag', () => {
  const line = JSON.stringify({
    type: 'tool_progress',
    tool_use_id: 'toolu_0123456789abcdef',
    tool_name: 'Bash',
    parent_tool_use_id: null,
    elapsed_time_seconds: 31,
    heartbeat: true,
    session_id: SESSION,
    uuid: '00000000-0000-0000-0000-000000000003',
  });

  const result = claudeCodeProtocolParser.parseStdout(SESSION, line);

  assert.equal(result.length, 1);
  const sm = result[0].serverMessage as any;
  assert.equal(sm.type, 'tool_progress');
  assert.equal(sm.heartbeat, true);
  assert.equal(sm.taskId, undefined);
});

test('tool_progress without tool_use_id is dropped silently', () => {
  const line = JSON.stringify({
    type: 'tool_progress',
    tool_name: 'Bash',
    elapsed_time_seconds: 5,
    session_id: SESSION,
    uuid: '00000000-0000-0000-0000-000000000004',
  });

  const result = claudeCodeProtocolParser.parseStdout(SESSION, line);

  assert.equal(result.length, 0);
  assert.equal(systemWarnings(result).length, 0);
});
