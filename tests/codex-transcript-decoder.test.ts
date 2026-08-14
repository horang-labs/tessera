import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createCodexTranscriptDecoderState,
  decodeCodexTranscript,
  decodeCodexTranscriptLine,
} from '@/lib/cli/providers/codex/transcript-decoder';

const TS = '2026-07-28T10:00:00.000Z';

function line(type: string, payload: Record<string, unknown>): string {
  return JSON.stringify({ type, timestamp: TS, payload });
}

test('conversation comes from event_msg', () => {
  const events = decodeCodexTranscript([
    line('event_msg', { type: 'user_message', message: 'build the thing' }),
    line('event_msg', { type: 'agent_message', message: 'on it' }),
  ]);

  assert.deepEqual(
    events.map((event) => [event.type, (event as any).content]),
    [['user_message', 'build the thing'], ['assistant_message', 'on it']],
  );
});

test('response_item messages are skipped — they duplicate event_msg', () => {
  // Measured on a real rollout: every event_msg turn reappears here, alongside
  // developer instructions and injected context nobody typed.
  const events = decodeCodexTranscript([
    line('event_msg', { type: 'user_message', message: 'hello' }),
    line('response_item', {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'hello' }],
    }),
    line('response_item', {
      type: 'message',
      role: 'developer',
      content: [{ type: 'input_text', text: '<permissions instructions>' }],
    }),
  ]);

  assert.equal(events.length, 1);
  assert.equal((events[0] as any).content, 'hello');
});

test('a function_call pairs with the output that arrives later', () => {
  const events = decodeCodexTranscript([
    line('response_item', {
      type: 'function_call',
      name: 'exec_command',
      call_id: 'call_1',
      arguments: JSON.stringify({ cmd: 'ls', workdir: '/repo' }),
    }),
    line('response_item', {
      type: 'function_call_output',
      call_id: 'call_1',
      output: 'a.txt\nb.txt',
    }),
  ]);

  assert.equal(events.length, 2);
  const [started, finished] = events as any[];
  assert.equal(started.status, 'running');
  assert.equal(started.toolUseId, 'call_1');
  // Codex names them cmd/workdir; the chat UI reads command/cwd.
  assert.equal(started.toolParams.command, 'ls');
  assert.equal(started.toolParams.cwd, '/repo');
  assert.equal(finished.status, 'completed');
  assert.equal(finished.toolUseId, 'call_1');
  assert.equal(finished.output, 'a.txt\nb.txt');
});

test('custom_tool_call (apply_patch) pairs the same way', () => {
  const events = decodeCodexTranscript([
    line('response_item', {
      type: 'custom_tool_call',
      name: 'apply_patch',
      call_id: 'call_2',
      input: '*** Begin Patch\n*** Add File: a.ts\n',
    }),
    line('response_item', {
      type: 'custom_tool_call_output',
      call_id: 'call_2',
      output: 'Success. Updated the following files:\nA a.ts',
    }),
  ]);

  const [started, finished] = events as any[];
  assert.equal(started.toolName, 'Write');
  assert.equal(started.toolKind, 'file_write');
  assert.ok(started.toolParams.patch.startsWith('*** Begin Patch'));
  assert.equal(finished.status, 'completed');
});

test('custom tool image output preserves text and an inline image result', () => {
  const events = decodeCodexTranscript([
    line('response_item', {
      type: 'custom_tool_call',
      name: 'exec',
      call_id: 'call_image',
      input: 'nested view_image call',
    }),
    line('response_item', {
      type: 'custom_tool_call_output',
      call_id: 'call_image',
      output: [
        { type: 'input_text', text: 'loaded image' },
        { type: 'input_image', image_url: 'data:image/png;base64,QUJDRA==' },
      ],
    }),
  ]);

  const finished = events[1] as any;
  assert.equal(finished.output, 'loaded image');
  assert.deepEqual(finished.toolUseResult, {
    kind: 'file_read',
    contentType: 'image',
    base64: 'QUJDRA==',
    mimeType: 'image/png',
  });
});

test('codex tool names normalize to the ones the chat UI renders', () => {
  const events = decodeCodexTranscript([
    line('response_item', { type: 'function_call', name: 'exec_command', call_id: 'a', arguments: '{}' }),
    line('response_item', { type: 'function_call', name: 'view_image', call_id: 'b', arguments: '{}' }),
    line('response_item', { type: 'function_call', name: 'update_plan', call_id: 'c', arguments: '{}' }),
    line('response_item', { type: 'function_call', name: 'write_stdin', call_id: 'd', arguments: '{}' }),
  ]);

  assert.deepEqual(
    events.map((event) => [(event as any).toolName, (event as any).toolKind]),
    [
      ['Bash', 'shell_command'],
      ['Read', 'file_read'],
      ['TodoWrite', 'todo_update'],
      ['Bash', 'shell_command'],
    ],
  );
});

test('an unknown tool keeps its own name', () => {
  const events = decodeCodexTranscript([
    line('response_item', { type: 'function_call', name: 'weird_tool', call_id: 'x', arguments: '{}' }),
  ]);
  assert.equal((events[0] as any).toolName, 'weird_tool');
});

test('a failed tool output is reported as an error', () => {
  const events = decodeCodexTranscript([
    line('response_item', { type: 'function_call', name: 'exec_command', call_id: 'e', arguments: '{}' }),
    line('response_item', {
      type: 'function_call_output',
      call_id: 'e',
      output: { success: false, output: 'command not found' },
    }),
  ]);

  const finished = events[1] as any;
  assert.equal(finished.status, 'error');
  assert.equal(finished.error, 'command not found');
  assert.equal(finished.output, undefined);
});

test('an output whose call was never seen is still surfaced', () => {
  const events = decodeCodexTranscript([
    line('response_item', { type: 'function_call_output', call_id: 'orphan', output: 'result' }),
  ]);

  assert.equal(events.length, 1);
  assert.equal((events[0] as any).toolName, 'Tool');
  assert.equal((events[0] as any).output, 'result');
});

test('reasoning is skipped — rollouts carry encrypted content, not text', () => {
  const events = decodeCodexTranscript([
    line('response_item', { type: 'reasoning', summary: [], encrypted_content: 'gAAAA...' }),
  ]);
  assert.deepEqual(events, []);
});

test('bookkeeping records and malformed lines are ignored', () => {
  const events = decodeCodexTranscript([
    '',
    'not json',
    JSON.stringify({ type: 'session_meta', payload: { session_id: 'x' } }),
    line('event_msg', { type: 'token_count', info: {} }),
    line('event_msg', { type: 'task_started' }),
    line('turn_context', { cwd: '/repo' }),
    line('event_msg', { type: 'user_message', message: 'still decoded' }),
  ]);

  assert.equal(events.length, 1);
  assert.equal((events[0] as any).content, 'still decoded');
});

test('empty messages produce nothing', () => {
  const events = decodeCodexTranscript([
    line('event_msg', { type: 'user_message', message: '   ' }),
    line('event_msg', { type: 'agent_message', message: '' }),
  ]);
  assert.deepEqual(events, []);
});

test('non-JSON arguments still render as a command', () => {
  const events = decodeCodexTranscript([
    line('response_item', { type: 'function_call', name: 'exec', call_id: 'z', arguments: 'raw text' }),
  ]);
  assert.equal((events[0] as any).toolParams.command, 'raw text');
});

test('decoder state pairs calls across separate line calls', () => {
  const state = createCodexTranscriptDecoderState();
  const opened = decodeCodexTranscriptLine(
    line('response_item', {
      type: 'function_call',
      name: 'exec_command',
      call_id: 'call_9',
      arguments: JSON.stringify({ cmd: 'ls' }),
    }),
    state,
  );
  assert.equal(opened.length, 1);

  const closed = decodeCodexTranscriptLine(
    line('response_item', { type: 'function_call_output', call_id: 'call_9', output: 'done' }),
    state,
  );
  assert.equal((closed[0] as any).toolName, 'Bash');
  assert.equal((closed[0] as any).status, 'completed');
});
