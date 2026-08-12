import assert from 'node:assert/strict';
import test from 'node:test';
import { selectRunningKanbanItems } from '@/lib/kanban/running-filter';
import { mergeTasksWithLiveSessions } from '@/lib/tasks/merge-tasks-with-live-sessions';
import { getKanbanScrollPositionKey } from '@/lib/kanban-scroll-position';
import type { UnifiedSession } from '@/types/chat';
import type { TaskEntity, TaskSession } from '@/types/task-entity';

function chat(
  id: string,
  isRunning: boolean,
  workflowStatus?: UnifiedSession['workflowStatus'],
): UnifiedSession {
  return {
    id,
    title: id,
    projectDir: 'project-a',
    originProjectId: 'project-a',
    isRunning,
    status: isRunning ? 'running' : 'stopped',
    workflowStatus,
    lastModified: '2026-08-11T00:00:00.000Z',
    createdAt: '2026-08-11T00:00:00.000Z',
    archived: false,
    sortOrder: 0,
  };
}

function taskSession(id: string, isRunning = false): TaskSession {
  return {
    id,
    originProjectId: 'project-a',
    title: id,
    lastModified: '2026-08-11T00:00:00.000Z',
    isRunning,
    sortOrder: 0,
  };
}

function task(id: string, sessions: TaskSession[]): TaskEntity {
  return {
    id,
    projectId: 'project-a',
    projectViewId: 'project-a',
    title: id,
    workflowStatus: 'in_review',
    sortOrder: 0,
    sessions,
    createdAt: '2026-08-11T00:00:00.000Z',
    updatedAt: '2026-08-11T00:00:00.000Z',
  };
}

test('selects running cards while preserving their workflow placement and order', () => {
  const firstRunningChat = chat('chat-running-review', true, 'in_review');
  const stoppedChat = chat('chat-stopped', false);
  const secondRunningChat = chat('chat-running-plain', true);
  const runningTask = task('task-running', [
    taskSession('task-child-stopped'),
    taskSession('task-child-live'),
  ]);
  const stoppedTask = task('task-stopped', [taskSession('task-child-stopped-only')]);
  const liveTaskChild = {
    ...chat('task-child-live', true),
    taskId: runningTask.id,
  };

  const result = selectRunningKanbanItems({
    tasks: mergeTasksWithLiveSessions([stoppedTask, runningTask], [liveTaskChild]),
    chats: [firstRunningChat, stoppedChat, secondRunningChat],
  });

  assert.deepEqual(result.tasks.map((item) => item.id), ['task-running']);
  assert.deepEqual(result.chats.map((item) => item.id), [
    'chat-running-review',
    'chat-running-plain',
  ]);
  assert.equal(result.count, 3);
  assert.equal(result.tasks[0]?.workflowStatus, 'in_review');
  assert.deepEqual(result.tasks[0]?.sessions.map((session) => [session.id, session.isRunning]), [
    ['task-child-stopped', false],
    ['task-child-live', true],
  ]);
});

test('counts a multi-session task once even when several child runtimes are live', () => {
  const runningTask = task('task-running', [
    taskSession('child-a', true),
    taskSession('child-b', true),
  ]);

  const result = selectRunningKanbanItems({
    tasks: [runningTask],
    chats: [],
  });

  assert.equal(result.tasks.length, 1);
  assert.equal(result.count, 1);
  assert.equal(runningTask.sessions.length, 2, 'input task remains unchanged');
});

test('keeps ALL and RUNNING horizontal scroll positions independent', () => {
  assert.notEqual(
    getKanbanScrollPositionKey('project-a', 'collection-a', false),
    getKanbanScrollPositionKey('project-a', 'collection-a', true),
  );
});
