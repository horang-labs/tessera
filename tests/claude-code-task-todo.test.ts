import assert from 'node:assert/strict';
import test from 'node:test';

import { ClaudeCodeProtocolParser } from '../src/lib/cli/providers/claude-code/protocol-parser';
import type { TodoUpdateToolResult } from '../src/types/tool-result';

function startTool(
  parser: ClaudeCodeProtocolParser,
  sessionId: string,
  toolUseId: string,
  name: string,
  input: Record<string, unknown>,
) {
  return parser.parseStdout(sessionId, JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id: toolUseId, name, input }] },
  }));
}

function finishTool(
  parser: ClaudeCodeProtocolParser,
  sessionId: string,
  toolUseId: string,
  result: unknown,
  options: { camelCase?: boolean; isError?: boolean; output?: string } = {},
) {
  return parser.parseStdout(sessionId, JSON.stringify({
    type: 'tool_result',
    tool_use_id: toolUseId,
    message: { is_error: !!options.isError, content: options.output ?? JSON.stringify(result) },
    [options.camelCase ? 'toolUseResult' : 'tool_use_result']: result,
  }));
}

function finishUserTool(
  parser: ClaudeCodeProtocolParser,
  sessionId: string,
  toolUseId: string,
  result: unknown,
  options: { camelCase?: boolean; isError?: boolean; output?: string } = {},
) {
  return parser.parseStdout(sessionId, JSON.stringify({
    type: 'user',
    message: {
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: toolUseId,
        is_error: !!options.isError,
        content: options.output ?? JSON.stringify(result),
      }],
    },
    [options.camelCase ? 'toolUseResult' : 'tool_use_result']: result,
  }));
}

function completedTodo(messages: ReturnType<ClaudeCodeProtocolParser['parseStdout']>) {
  const toolCall = messages
    .map((message) => message.serverMessage)
    .find((message): message is any => !!message && message.type === 'tool_call' && message.status !== 'running');
  return toolCall?.toolUseResult as TodoUpdateToolResult | undefined;
}

test('TaskCreate, TaskUpdate, and delete emit canonical todo snapshots only after success', () => {
  const parser = new ClaudeCodeProtocolParser();
  const session = 'task-transitions';

  const running = startTool(parser, session, 'create-1', 'TaskCreate', {
    subject: 'Investigate parser',
    activeForm: 'Investigating parser',
  });
  const runningCall = running.map((entry) => entry.serverMessage).find((message: any) => message?.type === 'tool_call') as any;
  assert.equal(runningCall.toolKind, 'todo_update');
  assert.equal(runningCall.toolUseResult, undefined, 'TaskCreate must not update the list optimistically');

  let todo = completedTodo(finishUserTool(parser, session, 'create-1', {
    task: { id: '1', subject: 'Investigate parser', status: 'pending' },
  }));
  assert.deepEqual(todo, {
    kind: 'todo_update',
    previous: [],
    next: [{ content: 'Investigate parser', status: 'pending', activeForm: 'Investigating parser' }],
  });

  startTool(parser, session, 'update-1', 'TaskUpdate', {
    taskId: '1',
    status: 'in_progress',
    activeForm: 'Inspecting stream events',
  });
  todo = completedTodo(finishTool(parser, session, 'update-1', { success: true, taskId: '1' }));
  assert.equal(todo?.next[0].status, 'in_progress');
  assert.equal(todo?.next[0].activeForm, 'Inspecting stream events');

  startTool(parser, session, 'rename-1', 'TaskUpdate', { task_id: '1', subject: 'Fix parser' });
  todo = completedTodo(finishTool(parser, session, 'rename-1', { success: true }));
  assert.equal(todo?.next[0].content, 'Fix parser');

  startTool(parser, session, 'delete-1', 'TaskUpdate', { id: '1', status: 'deleted' });
  todo = completedTodo(finishTool(parser, session, 'delete-1', { success: true }));
  assert.deepEqual(todo?.next, []);
});

test('TaskList replaces the session snapshot authoritatively, including an empty list', () => {
  const parser = new ClaudeCodeProtocolParser();
  const session = 'task-list';

  startTool(parser, session, 'list-1', 'TaskList', {});
  let todo = completedTodo(finishTool(parser, session, 'list-1', {
    tasks: [
      { id: 'a', subject: 'First', status: 'completed' },
      { id: 'b', subject: 'Second', status: 'in_progress', activeForm: 'Doing second' },
    ],
  }));
  assert.deepEqual(todo?.next, [
    { content: 'First', status: 'completed' },
    { content: 'Second', status: 'in_progress', activeForm: 'Doing second' },
  ]);

  startTool(parser, session, 'list-2', 'TaskList', {});
  todo = completedTodo(finishTool(parser, session, 'list-2', { tasks: [] }));
  assert.equal(todo?.previous.length, 2);
  assert.deepEqual(todo?.next, []);
});

test('TaskGet upserts a task while null and malformed results preserve the list', () => {
  const parser = new ClaudeCodeProtocolParser();
  const session = 'task-get';

  startTool(parser, session, 'get-1', 'TaskGet', { taskId: '7' });
  const todo = completedTodo(finishTool(parser, session, 'get-1', {
    task: { id: '7', subject: 'Recovered task', status: 'completed' },
  }, { camelCase: true, output: 'Task retrieved' }));
  assert.equal(todo?.next[0].content, 'Recovered task');

  startTool(parser, session, 'get-null', 'TaskGet', { taskId: 'missing' });
  assert.equal(completedTodo(finishTool(parser, session, 'get-null', { task: null })), undefined);

  startTool(parser, session, 'list-bad', 'TaskList', {});
  assert.equal(completedTodo(finishTool(parser, session, 'list-bad', { tasks: 'bad' })), undefined);

  startTool(parser, session, 'list-partial', 'TaskList', {});
  assert.equal(completedTodo(finishTool(parser, session, 'list-partial', {
    tasks: [{ id: '8', subject: 'Valid' }, { id: 'missing-subject' }],
  })), undefined);

  startTool(parser, session, 'list-duplicate', 'TaskList', {});
  assert.equal(completedTodo(finishTool(parser, session, 'list-duplicate', {
    tasks: [{ id: '8', subject: 'First' }, { id: '8', subject: 'Duplicate' }],
  })), undefined);

  startTool(parser, session, 'list-blank', 'TaskList', {});
  assert.equal(completedTodo(finishTool(parser, session, 'list-blank', {
    tasks: [{ id: ' ', subject: 'Blank id' }],
  })), undefined);
});

test('failed calls and updates for unknown ids never mutate or fabricate tasks', () => {
  const parser = new ClaudeCodeProtocolParser();
  const session = 'task-errors';

  startTool(parser, session, 'create-failed', 'TaskCreate', { subject: 'Must not appear' });
  assert.equal(completedTodo(finishTool(parser, session, 'create-failed', {
    task: { id: '1', subject: 'Must not appear' },
  }, { isError: true })), undefined);

  startTool(parser, session, 'create-unsuccessful', 'TaskCreate', { subject: 'Also hidden' });
  const failed = finishTool(parser, session, 'create-unsuccessful', {
    success: false,
    task: { id: '2', subject: 'Also hidden' },
  }, { output: 'Task creation failed' });
  assert.equal(completedTodo(failed), undefined);
  assert.equal(failed.find((entry) => entry.serverMessage?.type === 'tool_call')?.serverMessage?.status, 'error');

  startTool(parser, session, 'unknown-update', 'TaskUpdate', { taskId: '404', status: 'completed' });
  assert.equal(completedTodo(finishTool(parser, session, 'unknown-update', { success: true })), undefined);
});

test('batched results use their own block output and stale status transitions cannot regress', () => {
  const parser = new ClaudeCodeProtocolParser();
  const session = 'task-batched';

  startTool(parser, session, 'create-a', 'TaskCreate', { subject: 'Alpha' });
  startTool(parser, session, 'create-b', 'TaskCreate', { subject: 'Beta' });
  const batched = parser.parseStdout(session, JSON.stringify({
    type: 'user',
    message: {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'create-a', content: JSON.stringify({ task: { id: 'a', subject: 'Alpha' } }) },
        { type: 'tool_result', tool_use_id: 'create-b', content: JSON.stringify({ task: { id: 'b', subject: 'Beta' } }) },
      ],
    },
    tool_use_result: { task: { id: 'wrong', subject: 'Wrong shared result' } },
  }));
  const snapshots = batched
    .map((entry) => entry.serverMessage?.type === 'tool_call' ? entry.serverMessage.toolUseResult as TodoUpdateToolResult : undefined)
    .filter((value): value is TodoUpdateToolResult => value !== undefined);
  assert.deepEqual(snapshots.at(-1)?.next.map((todo) => todo.content), ['Alpha', 'Beta']);

  startTool(parser, session, 'done-a', 'TaskUpdate', { taskId: 'a', status: 'completed' });
  startTool(parser, session, 'active-a', 'TaskUpdate', { taskId: 'a', status: 'in_progress' });
  let todo = completedTodo(finishTool(parser, session, 'done-a', {
    success: true,
    statusChange: { from: 'pending', to: 'completed' },
  }));
  assert.equal(todo?.next[0].status, 'completed');
  todo = completedTodo(finishTool(parser, session, 'active-a', {
    success: true,
    statusChange: { from: 'pending', to: 'in_progress' },
  }));
  assert.equal(todo, undefined);
});

test('valid JSON output is used when the structured result object is malformed', () => {
  const parser = new ClaudeCodeProtocolParser();
  const session = 'task-result-fallback';
  startTool(parser, session, 'create-1', 'TaskCreate', { subject: 'Recovered' });
  const messages = parser.parseStdout(session, JSON.stringify({
    type: 'tool_result',
    tool_use_id: 'create-1',
    message: { is_error: false, content: JSON.stringify({ task: { id: '1', subject: 'Recovered' } }) },
    tool_use_result: {},
  }));
  assert.equal(completedTodo(messages)?.next[0].content, 'Recovered');
});

test('task maps are isolated by session and cleared on process exit', () => {
  const parser = new ClaudeCodeProtocolParser();

  for (const [session, subject] of [['session-a', 'Alpha'], ['session-b', 'Beta']]) {
    startTool(parser, session, `${session}-create`, 'TaskCreate', { subject });
    finishTool(parser, session, `${session}-create`, { task: { id: '1', subject } });
  }

  startTool(parser, 'session-a', 'a-update', 'TaskUpdate', { taskId: '1', status: 'completed' });
  const alpha = completedTodo(finishTool(parser, 'session-a', 'a-update', { success: true }));
  assert.deepEqual(alpha?.next, [{ content: 'Alpha', status: 'completed' }]);

  startTool(parser, 'session-b', 'b-update', 'TaskUpdate', { taskId: '1', status: 'in_progress' });
  const beta = completedTodo(finishTool(parser, 'session-b', 'b-update', { success: true }));
  assert.deepEqual(beta?.next, [{ content: 'Beta', status: 'in_progress' }]);

  parser.handleProcessExit('session-a', 0);
  startTool(parser, 'session-a', 'after-exit', 'TaskUpdate', { taskId: '1', status: 'completed' });
  assert.equal(completedTodo(finishTool(parser, 'session-a', 'after-exit', { success: true })), undefined);
});

test('legacy TodoWrite remains compatible', () => {
  const parser = new ClaudeCodeProtocolParser();
  const session = 'legacy-todo';
  const todos = [
    { content: 'Old protocol', status: 'in_progress', activeForm: 'Testing old protocol' },
    { content: 'Ship', status: 'pending' },
  ];

  startTool(parser, session, 'todo-1', 'TodoWrite', { todos });
  let todo = completedTodo(finishTool(parser, session, 'todo-1', 'Todos updated'));
  assert.deepEqual(todo?.next, todos);

  startTool(parser, session, 'todo-clear', 'TodoWrite', { todos: [] });
  todo = completedTodo(finishTool(parser, session, 'todo-clear', 'Todos cleared'));
  assert.deepEqual(todo, {
    kind: 'todo_update',
    previous: todos,
    next: [],
  });
});
