import assert from 'node:assert/strict';
import test from 'node:test';

import { useSessionStore } from '@/stores/session-store';
import { useTaskStore } from '@/stores/task-store';
import type { ProjectGroup } from '@/types/chat';
import type { TaskEntity, TaskSession } from '@/types/task-entity';

const originalFetch = globalThis.fetch;

function taskSession(id: string, sortOrder: number): TaskSession {
  return {
    id,
    originProjectId: 'project-a',
    title: id,
    lastModified: '2026-09-01T00:00:00.000Z',
    isRunning: false,
    sortOrder,
  };
}

function task(projectViewId: string): TaskEntity {
  return {
    id: 'shared-worktree',
    worktreeId: 'wt-shared',
    projectId: 'project-a',
    projectViewId,
    title: 'Shared Worktree',
    workflowStatus: 'todo',
    sortOrder: 0,
    sessions: [taskSession('session-a', 0), taskSession('session-b', 1)],
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
  };
}

function project(projectId: string): ProjectGroup {
  return {
    encodedDir: projectId,
    displayName: projectId,
    decodedPath: `/${projectId}`,
    isCurrent: projectId === 'project-a',
    // Linked Worktree Sessions deliberately live only in the Task projection.
    // This is the Project View shape that exposed the reorder regression.
    sessions: [],
    totalSessions: 0,
    allLoaded: true,
    loadedCount: 0,
    nextCursor: null,
    loadBatchIndex: 0,
  };
}

function taskSessionIds(tasks: TaskEntity[]): string[] {
  return tasks[0]?.sessions.map((session) => session.id) ?? [];
}

test.afterEach(() => {
  globalThis.fetch = originalFetch;
  useTaskStore.setState(useTaskStore.getInitialState(), true);
  useSessionStore.setState(useSessionStore.getInitialState(), true);
});

test('reordering linked Sessions updates every loaded Task appearance immediately', () => {
  globalThis.fetch = async () => Response.json({ success: true });
  const inA = task('project-a');
  const inC = task('project-c');
  useTaskStore.setState({
    ...useTaskStore.getInitialState(),
    tasks: [inC],
    tasksByProject: { 'project-a': [inA], 'project-c': [inC] },
    currentProjectId: 'project-c',
    loaded: true,
    loadedProjects: { 'project-a': true, 'project-c': true },
  }, true);
  useSessionStore.setState({
    ...useSessionStore.getInitialState(),
    projects: [project('project-a'), project('project-c')],
  }, true);

  useSessionStore.getState().reorderSessionsByIds(['session-b', 'session-a']);

  assert.deepEqual(taskSessionIds(useTaskStore.getState().tasks), ['session-b', 'session-a']);
  assert.deepEqual(
    Object.values(useTaskStore.getState().tasksByProject).map(taskSessionIds),
    [
      ['session-b', 'session-a'],
      ['session-b', 'session-a'],
    ],
  );
  assert.deepEqual(
    useTaskStore.getState().tasksByProject['project-a'][0]?.sessions.map((session) => session.sortOrder),
    [0, 1],
  );
});
