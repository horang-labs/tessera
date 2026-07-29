import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createClaudeTranscriptDecoderState,
  decodeClaudeTranscript,
  decodeClaudeTranscriptLine,
} from '@/lib/cli/providers/claude-code/transcript-decoder';

const TS = '2026-07-28T10:00:00.000Z';

function assistantLine(content: unknown[], extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'assistant',
    timestamp: TS,
    message: { role: 'assistant', content },
    ...extra,
  });
}

function userLine(content: unknown, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'user',
    timestamp: TS,
    message: { role: 'user', content },
    ...extra,
  });
}

test('plain user and assistant turns become chat messages', () => {
  const events = decodeClaudeTranscript(
    [userLine('build the thing'), assistantLine([{ type: 'text', text: 'on it' }])],
    'session-1',
  );

  assert.deepEqual(
    events.map((event) => [event.type, (event as any).content]),
    [['user_message', 'build the thing'], ['assistant_message', 'on it']],
  );
});

test('a tool_use pairs with the tool_result that arrives in a later record', () => {
  const events = decodeClaudeTranscript(
    [
      assistantLine([
        { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } },
      ]),
      userLine([
        { type: 'tool_result', tool_use_id: 'toolu_1', content: 'a.txt\nb.txt' },
      ]),
    ],
    'session-1',
  );

  assert.equal(events.length, 2);
  const [started, finished] = events as any[];
  assert.equal(started.type, 'tool_call');
  assert.equal(started.status, 'running');
  assert.equal(started.toolUseId, 'toolu_1');
  // Same toolUseId on both, so the replay reducer upserts them into one call.
  assert.equal(finished.type, 'tool_call');
  assert.equal(finished.status, 'completed');
  assert.equal(finished.toolUseId, 'toolu_1');
  assert.equal(finished.toolName, 'Bash');
  assert.equal(finished.output, 'a.txt\nb.txt');
});

test('an errored tool_result is reported as an error, not output', () => {
  const events = decodeClaudeTranscript(
    [
      assistantLine([
        { type: 'tool_use', id: 'toolu_2', name: 'Bash', input: { command: 'nope' } },
      ]),
      userLine([
        { type: 'tool_result', tool_use_id: 'toolu_2', content: 'command not found', is_error: true },
      ]),
    ],
    'session-1',
  );

  const finished = events[1] as any;
  assert.equal(finished.status, 'error');
  assert.equal(finished.error, 'command not found');
  assert.equal(finished.output, undefined);
});

test('a tool_result whose tool_use was never seen is still surfaced', () => {
  // Happens when the transcript is read from a resumed/truncated session.
  const events = decodeClaudeTranscript(
    [userLine([{ type: 'tool_result', tool_use_id: 'toolu_orphan', content: 'output' }])],
    'session-1',
  );

  assert.equal(events.length, 1);
  const [orphan] = events as any[];
  assert.equal(orphan.type, 'tool_call');
  assert.equal(orphan.status, 'completed');
  assert.equal(orphan.output, 'output');
});

test('injected user turns drop their prose but keep tool results', () => {
  const events = decodeClaudeTranscript(
    [
      assistantLine([
        { type: 'tool_use', id: 'toolu_3', name: 'Read', input: { file_path: '/tmp/a' } },
      ]),
      userLine(
        [
          { type: 'text', text: 'system scaffolding the user never typed' },
          { type: 'tool_result', tool_use_id: 'toolu_3', content: 'file body' },
        ],
        { isMeta: true },
      ),
    ],
    'session-1',
  );

  const types = events.map((event) => event.type);
  assert.deepEqual(types, ['tool_call', 'tool_call']);
  assert.equal((events[1] as any).output, 'file body');
});

test('a meta user turn carrying only prose produces nothing', () => {
  const events = decodeClaudeTranscript(
    [userLine('injected context', { isCompactSummary: true })],
    'session-1',
  );
  assert.deepEqual(events, []);
});

test('sidechain records are skipped — subagents render under their parent Task call', () => {
  const events = decodeClaudeTranscript(
    [
      assistantLine([{ type: 'text', text: 'subagent chatter' }], { isSidechain: true }),
      userLine('subagent prompt', { isSidechain: true }),
    ],
    'session-1',
  );
  assert.deepEqual(events, []);
});

test('a slash command renders as the command, not its XML scaffolding', () => {
  const events = decodeClaudeTranscript(
    [userLine('<command-name>/effort</command-name>\n<command-args>high</command-args>')],
    'session-1',
  );

  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'user_message');
  assert.equal((events[0] as any).content, '/effort high');
});

test('slash command output is demoted to a system note', () => {
  const events = decodeClaudeTranscript(
    [userLine('<local-command-stdout>effort set to high</local-command-stdout>')],
    'session-1',
  );

  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'system');
  assert.equal((events[0] as any).message, 'effort set to high');
  assert.equal((events[0] as any).severity, 'info');
});

test('empty slash command output is dropped entirely', () => {
  const events = decodeClaudeTranscript(
    [userLine('<local-command-stdout></local-command-stdout>')],
    'session-1',
  );
  assert.deepEqual(events, []);
});

test('thinking blocks decode, and signature-only ones are skipped', () => {
  const events = decodeClaudeTranscript(
    [
      assistantLine([{ type: 'thinking', thinking: 'weighing options', signature: 'sig' }]),
      // Claude persists reasoning as signature-only for most builds; an empty
      // block would otherwise render as a blank thinking bubble.
      assistantLine([{ type: 'thinking', thinking: '', signature: 'sig2' }]),
    ],
    'session-1',
  );

  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'thinking');
  assert.equal((events[0] as any).content, 'weighing options');
});

test('unknown record types and malformed lines are ignored, not fatal', () => {
  const events = decodeClaudeTranscript(
    [
      '',
      '   ',
      'not json at all',
      JSON.stringify({ type: 'mode', mode: 'default' }),
      JSON.stringify({ type: 'file-history-snapshot' }),
      JSON.stringify({ type: 'ai-title', title: 'x' }),
      userLine('still decoded'),
    ],
    'session-1',
  );

  assert.equal(events.length, 1);
  assert.equal((events[0] as any).content, 'still decoded');
});

test('decoder state pairs tools across separate line calls', () => {
  const state = createClaudeTranscriptDecoderState('session-1');
  const opened = decodeClaudeTranscriptLine(
    assistantLine([{ type: 'tool_use', id: 'toolu_9', name: 'Bash', input: { command: 'ls' } }]),
    state,
  );
  assert.equal(opened.length, 1);

  const closed = decodeClaudeTranscriptLine(
    userLine([{ type: 'tool_result', tool_use_id: 'toolu_9', content: 'done' }]),
    state,
  );
  assert.equal((closed[0] as any).toolName, 'Bash');
  assert.equal((closed[0] as any).status, 'completed');
});

test('assistant prose is emitted after the tool calls in the same record', () => {
  const events = decodeClaudeTranscript(
    [
      assistantLine([
        { type: 'text', text: 'let me check' },
        { type: 'tool_use', id: 'toolu_10', name: 'Bash', input: { command: 'ls' } },
      ]),
    ],
    'session-1',
  );

  assert.deepEqual(events.map((event) => event.type), ['tool_call', 'assistant_message']);
});

test('timestamps come from the record, falling back when unusable', () => {
  const [withStamp] = decodeClaudeTranscript([userLine('hi')], 'session-1');
  assert.equal(withStamp.timestamp, TS);

  const [withoutStamp] = decodeClaudeTranscript(
    [JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } })],
    'session-1',
  );
  assert.ok(!Number.isNaN(Date.parse(withoutStamp.timestamp)));
});
