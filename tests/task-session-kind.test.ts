import assert from 'node:assert/strict';
import test from 'node:test';
import { getCollectionSessionSnapshots } from '@/lib/chat/collection-status-indicator';
import {
  countRunningCollectionGroupItems,
  filterCollectionGroupsByRunning,
  getRunningCollectionGroupSessionIds,
} from '@/lib/chat/build-collection-groups';
import { mergeTasksWithLiveSessions } from '@/lib/tasks/merge-tasks-with-live-sessions';
import { resolveSessionRuntimePresentation } from '@/lib/session/session-runtime-presentation';
import type { UnifiedSession } from '@/types/chat';
import type { TaskEntity } from '@/types/task-entity';

const terminalSession = {
  id: 'terminal-task-session',
  title: 'PTY session',
  projectDir: 'project-a',
  isRunning: true,
  status: 'running',
  lastModified: '2026-07-14T00:00:00.000Z',
  createdAt: '2026-07-14T00:00:00.000Z',
  kind: 'terminal',
  archived: false,
  sortOrder: 0,
  taskId: 'task-a',
} satisfies UnifiedSession;

const task = {
  id: 'task-a',
  projectId: 'project-a',
  title: 'Task',
  workflowStatus: 'in_progress',
  sortOrder: 0,
  sessions: [],
  createdAt: '2026-07-14T00:00:00.000Z',
  updatedAt: '2026-07-14T00:00:00.000Z',
} satisfies TaskEntity;

test('task session snapshots preserve the fixed PTY execution kind', () => {
  const [mergedTask] = mergeTasksWithLiveSessions([task], [terminalSession]);

  assert.equal(mergedTask.sessions[0]?.kind, 'terminal');
  assert.equal(getCollectionSessionSnapshots([mergedTask], [])[0]?.kind, 'terminal');
  assert.deepEqual(resolveSessionRuntimePresentation(mergedTask.sessions[0]), {
    showRunning: true,
    canStop: true,
  });
});

test('running menus and stop-all targets include live PTY runtimes', () => {
  const guiSession = {
    ...terminalSession,
    id: 'gui-session',
    taskId: undefined,
    kind: 'chat',
  } satisfies UnifiedSession;
  const terminalChat = {
    ...terminalSession,
    id: 'terminal-chat',
    taskId: undefined,
  } satisfies UnifiedSession;
  const terminalTask = mergeTasksWithLiveSessions([task], [terminalSession])[0];
  const groups = [{
    collectionId: null,
    tasks: [terminalTask],
    chats: [guiSession, terminalChat],
  }];

  assert.equal(countRunningCollectionGroupItems(groups), 3);
  assert.deepEqual(getRunningCollectionGroupSessionIds(groups), [
    'terminal-task-session',
    'gui-session',
    'terminal-chat',
  ]);
  assert.deepEqual(filterCollectionGroupsByRunning(groups), [{
    collectionId: null,
    tasks: [terminalTask],
    chats: [guiSession, terminalChat],
  }]);
});
