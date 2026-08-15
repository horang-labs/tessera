import assert from 'node:assert/strict';
import test from 'node:test';

import { requestSessionArchive } from '@/lib/session/session-archive-client';
import { useSessionStore } from '@/stores/session-store';
import { useTaskStore } from '@/stores/task-store';
import type { TaskEntity } from '@/types/task-entity';

function taskWithSessions(sessionIds: string[]): TaskEntity {
  return {
    id: 'task-worktree',
    worktreeId: 'wt-worktree',
    projectId: 'project-a',
    projectViewId: 'project-a',
    title: 'Worktree',
    workflowStatus: 'in_progress',
    sortOrder: 0,
    sessions: sessionIds.map((id, index) => ({
      id,
      originProjectId: 'project-a',
      title: id,
      lastModified: '2026-08-13T00:00:00.000Z',
      isRunning: false,
      sortOrder: index,
    })),
    createdAt: '2026-08-13T00:00:00.000Z',
    updatedAt: '2026-08-13T00:00:00.000Z',
  };
}

test('Session-level archive entry points preserve the canonical Session identity', (t) => {
  const requested: Array<[sessionId: string, archived: boolean]> = [];
  const originalToggleArchive = useSessionStore.getState().toggleArchive;
  useSessionStore.setState({
    toggleArchive: (sessionId, archived) => {
      requested.push([sessionId, archived]);
    },
  });
  t.after(() => {
    useSessionStore.setState({ toggleArchive: originalToggleArchive });
  });

  requestSessionArchive('task-owned-session');

  assert.deepEqual(requested, [['task-owned-session', true]]);
});

test('archiving the sole Session archives its Worktree Task', (t) => {
  const taskArchives: Array<[taskId: string, archived: boolean]> = [];
  const sessionArchives: Array<[sessionId: string, archived: boolean]> = [];
  const task = taskWithSessions(['only-session']);
  useTaskStore.setState({
    ...useTaskStore.getInitialState(),
    tasks: [task],
    tasksByProject: { 'project-a': [task] },
    currentProjectId: 'project-a',
    toggleTaskArchive: async (taskId, archived) => {
      taskArchives.push([taskId, archived]);
      return true;
    },
  }, true);
  useSessionStore.setState({
    toggleArchive: (sessionId, archived) => {
      sessionArchives.push([sessionId, archived]);
    },
  });
  t.after(() => {
    useTaskStore.setState(useTaskStore.getInitialState(), true);
    useSessionStore.setState(useSessionStore.getInitialState(), true);
  });

  requestSessionArchive('only-session');

  assert.deepEqual(taskArchives, [['task-worktree', true]]);
  assert.deepEqual(sessionArchives, []);
});

test('archiving one of multiple Worktree Sessions preserves its siblings', (t) => {
  const taskArchives: Array<[taskId: string, archived: boolean]> = [];
  const sessionArchives: Array<[sessionId: string, archived: boolean]> = [];
  const task = taskWithSessions(['session-one', 'session-two']);
  useTaskStore.setState({
    ...useTaskStore.getInitialState(),
    tasks: [task],
    tasksByProject: { 'project-a': [task] },
    currentProjectId: 'project-a',
    toggleTaskArchive: async (taskId, archived) => {
      taskArchives.push([taskId, archived]);
      return true;
    },
  }, true);
  useSessionStore.setState({
    toggleArchive: (sessionId, archived) => {
      sessionArchives.push([sessionId, archived]);
    },
  });
  t.after(() => {
    useTaskStore.setState(useTaskStore.getInitialState(), true);
    useSessionStore.setState(useSessionStore.getInitialState(), true);
  });

  requestSessionArchive('session-one');

  assert.deepEqual(taskArchives, []);
  assert.deepEqual(sessionArchives, [['session-one', true]]);
});

test('the rendered Task snapshot wins over a stale singleton projection', (t) => {
  const taskArchives: Array<[taskId: string, archived: boolean]> = [];
  const sessionArchives: Array<[sessionId: string, archived: boolean]> = [];
  const staleTask = taskWithSessions(['session-one']);
  const renderedTask = taskWithSessions(['session-one', 'session-two']);
  useTaskStore.setState({
    ...useTaskStore.getInitialState(),
    tasks: [staleTask],
    tasksByProject: { 'project-a': [staleTask] },
    currentProjectId: 'project-a',
    toggleTaskArchive: async (taskId, archived) => {
      taskArchives.push([taskId, archived]);
      return true;
    },
  }, true);
  useSessionStore.setState({
    toggleArchive: (sessionId, archived) => {
      sessionArchives.push([sessionId, archived]);
    },
  });
  t.after(() => {
    useTaskStore.setState(useTaskStore.getInitialState(), true);
    useSessionStore.setState(useSessionStore.getInitialState(), true);
  });

  requestSessionArchive('session-one', true, renderedTask);

  assert.deepEqual(taskArchives, []);
  assert.deepEqual(sessionArchives, [['session-one', true]]);
});
