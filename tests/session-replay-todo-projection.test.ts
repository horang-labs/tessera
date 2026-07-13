import assert from 'node:assert/strict';
import test, { beforeEach } from 'node:test';

import { applySessionReplayEventsToStores } from '../src/lib/chat/apply-session-replay-events';
import { restoreSessionReplay } from '../src/lib/chat/restore-session-replay';
import {
  applySessionReplayEvent,
  createEmptySessionReplayState,
} from '../src/lib/session-replay-reducer';
import type { SessionReplayEvent } from '../src/lib/session-replay-types';
import { useChatStore } from '../src/stores/chat-store';
import type { TodoItem } from '../src/types/cli-jsonl-schemas';

const SID = 'todo-session';
const OTHER_SID = 'todo-session-other';
const TS = '2026-07-13T00:00:00.000Z';

function todoEvent(
  id: string,
  status: 'running' | 'completed' | 'error',
  next: TodoItem[],
): SessionReplayEvent {
  return {
    v: 1,
    type: 'tool_call',
    timestamp: TS,
    toolName: 'TaskUpdate',
    toolKind: 'todo_update',
    toolParams: {},
    status,
    toolUseId: id,
    toolUseResult: { kind: 'todo_update', previous: [], next },
  };
}

beforeEach(() => {
  useChatStore.setState({
    messages: new Map(),
    todoSnapshots: new Map(),
    historyLoaded: new Set(),
    activeInteractivePrompt: new Map(),
  });
});

test('replay projection updates only from completed canonical todo results', () => {
  const initial = createEmptySessionReplayState();
  const active: TodoItem[] = [
    { content: 'Inspect events', status: 'in_progress', activeForm: 'Inspecting events' },
    { content: 'Ship UI', status: 'pending' },
  ];

  const running = applySessionReplayEvent(SID, initial, {
    ...todoEvent('t1', 'running', active),
    toolUseResult: undefined,
  });
  assert.deepEqual(running.todoSnapshot, [], 'running calls must not update optimistically');

  const completed = applySessionReplayEvent(SID, running, todoEvent('t1', 'completed', active), {
    lazyToolOutput: true,
  });
  assert.deepEqual(completed.todoSnapshot, active);
  const toolMessage = completed.messages.find((message) => message.type === 'tool_call');
  assert.equal(toolMessage?.type === 'tool_call' ? toolMessage.toolUseResult : undefined, undefined);

  const failed = applySessionReplayEvent(SID, completed, todoEvent('t2', 'error', [
    { content: 'Wrong', status: 'completed' },
  ]));
  assert.deepEqual(failed.todoSnapshot, active, 'failed results preserve the previous snapshot');

  const malformed = applySessionReplayEvent(SID, failed, {
    ...todoEvent('t3', 'completed', []),
    toolUseResult: { kind: 'todo_update', next: [{ content: '', status: 'pending' }] } as any,
  });
  assert.deepEqual(malformed.todoSnapshot, active, 'malformed results preserve the previous snapshot');
});

test('live events update, isolate, and clear per-session store projections', () => {
  const active: TodoItem[] = [{ content: 'Alpha', status: 'pending' }];
  const other: TodoItem[] = [{ content: 'Beta', status: 'in_progress' }];

  applySessionReplayEventsToStores(SID, [todoEvent('a', 'completed', active)]);
  applySessionReplayEventsToStores(OTHER_SID, [todoEvent('b', 'completed', other)]);

  assert.deepEqual(useChatStore.getState().todoSnapshots.get(SID), active);
  assert.deepEqual(useChatStore.getState().todoSnapshots.get(OTHER_SID), other);

  applySessionReplayEventsToStores(SID, [todoEvent('a-clear', 'completed', [])]);
  assert.equal(useChatStore.getState().todoSnapshots.has(SID), false);
  assert.deepEqual(useChatStore.getState().todoSnapshots.get(OTHER_SID), other);

  useChatStore.getState().resetForReload(OTHER_SID);
  assert.equal(useChatStore.getState().todoSnapshots.has(OTHER_SID), false);

  useChatStore.getState().setTodoSnapshot(OTHER_SID, other);
  useChatStore.getState().clearSession(OTHER_SID);
  assert.equal(useChatStore.getState().todoSnapshots.has(OTHER_SID), false);
});

test('history restore replaces stale todo state without fetching lazy tool output', () => {
  useChatStore.getState().setTodoSnapshot(SID, [{ content: 'Stale', status: 'pending' }]);

  const restored: TodoItem[] = [
    { content: 'Done', status: 'completed' },
    { content: 'Continue', status: 'in_progress', activeForm: 'Continuing' },
  ];
  restoreSessionReplay(SID, { messages: [], todoSnapshot: restored });
  assert.deepEqual(useChatStore.getState().todoSnapshots.get(SID), restored);

  restoreSessionReplay(SID, { messages: [] });
  assert.equal(useChatStore.getState().todoSnapshots.has(SID), false);
});
