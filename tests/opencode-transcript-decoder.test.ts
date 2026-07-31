import assert from 'node:assert/strict';
import test from 'node:test';

import { decodeOpenCodeSession } from '@/lib/cli/providers/opencode/transcript-decoder';

function session(messages: unknown[]): any {
  return { messages };
}

function message(role: string, parts: unknown[], created = 1770474900000): unknown {
  return { info: { role, time: { created } }, parts };
}

test('user and assistant text become chat messages', () => {
  const events = decodeOpenCodeSession(session([
    message('user', [{ type: 'text', text: 'hi' }]),
    message('assistant', [{ type: 'text', text: 'hello' }]),
  ]));

  assert.deepEqual(
    events.map((event) => [event.type, (event as any).content]),
    [['user_message', 'hi'], ['assistant_message', 'hello']],
  );
});

test('a tool part carries its own result — no pairing needed', () => {
  // OpenCode keeps input and output in one record, unlike Claude and Codex.
  const events = decodeOpenCodeSession(session([
    message('assistant', [{
      type: 'tool',
      tool: 'bash',
      callID: 'call_1',
      state: {
        status: 'completed',
        input: { command: 'ls' },
        output: 'a.txt\nb.txt',
        time: { start: 1770474900233 },
      },
    }]),
  ]));

  assert.equal(events.length, 1);
  const [call] = events as any[];
  assert.equal(call.type, 'tool_call');
  assert.equal(call.status, 'completed');
  assert.equal(call.toolName, 'Bash');
  assert.equal(call.toolKind, 'shell_command');
  assert.equal(call.toolParams.command, 'ls');
  assert.equal(call.output, 'a.txt\nb.txt');
  assert.equal(call.toolUseId, 'call_1');
});

test('tool names normalize to the ones the chat UI renders', () => {
  const events = decodeOpenCodeSession(session([
    message('assistant', [
      { type: 'tool', tool: 'read', callID: 'a', state: { status: 'completed', input: {} } },
      { type: 'tool', tool: 'todowrite', callID: 'b', state: { status: 'completed', input: {} } },
      { type: 'tool', tool: 'webfetch', callID: 'c', state: { status: 'completed', input: {} } },
    ]),
  ]));

  assert.deepEqual(
    events.map((event) => (event as any).toolName),
    ['Read', 'TodoWrite', 'WebFetch'],
  );
});

test('a failed tool reports an error rather than output', () => {
  const events = decodeOpenCodeSession(session([
    message('assistant', [{
      type: 'tool',
      tool: 'bash',
      callID: 'x',
      state: { status: 'error', input: { command: 'nope' }, output: 'command not found' },
    }]),
  ]));

  const [call] = events as any[];
  assert.equal(call.status, 'error');
  assert.equal(call.error, 'command not found');
  assert.equal(call.output, undefined);
});

test('an unfinished tool stays running', () => {
  const events = decodeOpenCodeSession(session([
    message('assistant', [{
      type: 'tool',
      tool: 'bash',
      callID: 'y',
      state: { status: 'pending', input: {} },
    }]),
  ]));
  assert.equal((events[0] as any).status, 'running');
});

test('reasoning becomes a thinking event', () => {
  const events = decodeOpenCodeSession(session([
    message('assistant', [
      { type: 'reasoning', text: 'weighing options', time: { start: 1770474900100 } },
      { type: 'text', text: 'done' },
    ]),
  ]));

  assert.deepEqual(
    events.map((event) => event.type),
    ['thinking', 'assistant_message'],
  );
  assert.equal((events[0] as any).content, 'weighing options');
});

test('step-start and step-finish are dropped', () => {
  const events = decodeOpenCodeSession(session([
    message('assistant', [
      { type: 'step-start' },
      { type: 'text', text: 'body' },
      { type: 'step-finish', cost: 0, tokens: {} },
    ]),
  ]));

  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'assistant_message');
});

test('text parts within a message are concatenated', () => {
  const events = decodeOpenCodeSession(session([
    message('assistant', [
      { type: 'text', text: 'one ' },
      { type: 'text', text: 'two' },
    ]),
  ]));

  assert.equal(events.length, 1);
  assert.equal((events[0] as any).content, 'one two');
});

test('empty or malformed input yields nothing', () => {
  assert.deepEqual(decodeOpenCodeSession(null), []);
  assert.deepEqual(decodeOpenCodeSession(session([])), []);
  assert.deepEqual(decodeOpenCodeSession({ messages: 'nope' } as any), []);
  assert.deepEqual(decodeOpenCodeSession(session([message('user', [])])), []);
  assert.deepEqual(
    decodeOpenCodeSession(session([message('user', [{ type: 'text', text: '   ' }])])),
    [],
  );
});

test('timestamps come from the message, falling back when absent', () => {
  const [withStamp] = decodeOpenCodeSession(session([
    message('user', [{ type: 'text', text: 'hi' }], 1770474900000),
  ]));
  assert.equal(withStamp.timestamp, new Date(1770474900000).toISOString());

  const [withoutStamp] = decodeOpenCodeSession(session([
    { info: { role: 'user' }, parts: [{ type: 'text', text: 'hi' }] },
  ]));
  assert.ok(!Number.isNaN(Date.parse(withoutStamp.timestamp)));
});

test('an unknown tool keeps a readable name', () => {
  const events = decodeOpenCodeSession(session([
    message('assistant', [{
      type: 'tool',
      tool: 'custom_thing',
      callID: 'z',
      state: { status: 'completed', input: {} },
    }]),
  ]));
  assert.equal((events[0] as any).toolName, 'Custom_thing');
});
