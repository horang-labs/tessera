import assert from 'node:assert/strict';
import test from 'node:test';
import { useSessionStore } from '@/stores/session-store';
import { useTaskStore } from '@/stores/task-store';
import type { ProjectGroup, UnifiedSession } from '@/types/chat';
import type { TaskEntity } from '@/types/task-entity';

const originalFetch = globalThis.fetch;

function session(id: string, projectDir: string, sortOrder: number): UnifiedSession {
  return {
    id,
    title: id,
    projectDir,
    originProjectId: 'project-a',
    status: 'completed',
    isRunning: false,
    archived: false,
    sortOrder,
    createdAt: '2026-08-12T00:00:00.000Z',
    lastModified: '2026-08-12T00:00:00.000Z',
  };
}

function project(id: string, sessions: UnifiedSession[]): ProjectGroup {
  return {
    encodedDir: id,
    displayName: id,
    decodedPath: `/${id}`,
    isCurrent: id === 'project-c',
    sessions,
    totalSessions: sessions.length,
    allLoaded: true,
    loadedCount: sessions.length,
    nextCursor: null,
    loadBatchIndex: 0,
  };
}

function taskEntity(id: string, projectViewId: string, sortOrder: number): TaskEntity {
  return {
    id,
    projectId: 'project-a',
    projectViewId,
    title: id,
    workflowStatus: 'todo',
    sortOrder,
    sessions: [],
    createdAt: '2026-08-12T00:00:00.000Z',
    updatedAt: '2026-08-12T00:00:00.000Z',
  };
}

function seedOrdering(): void {
  const taskIds = ['task-one', 'task-two'];
  useTaskStore.setState({
    ...useTaskStore.getInitialState(),
    tasks: taskIds.map((id, index) => taskEntity(id, 'project-a', index)),
    tasksByProject: {
      'project-a': taskIds.map((id, index) => taskEntity(id, 'project-a', index)),
      'project-c': taskIds.map((id, index) => taskEntity(id, 'project-c', index)),
    },
    currentProjectId: 'project-a',
  }, true);
  const sessionIds = ['session-one', 'session-two'];
  useSessionStore.setState({
    ...useSessionStore.getInitialState(),
    projects: [
      project('project-a', sessionIds.map((id, index) => session(id, 'project-a', index))),
      project('project-c', sessionIds.map((id, index) => session(id, 'project-c', index))),
    ],
  }, true);
}

test.afterEach(() => {
  globalThis.fetch = originalFetch;
  useTaskStore.setState(useTaskStore.getInitialState(), true);
  useSessionStore.setState(useSessionStore.getInitialState(), true);
});

test('same-bucket reorder changes only the visible Project View ordering', () => {
  globalThis.fetch = async () => new Response('{}', { status: 200 });
  seedOrdering();

  useTaskStore.getState().reorderTasks(['task-two', 'task-one'], 'project-c');
  useSessionStore.getState().reorderProjectSessions(
    'project-c',
    ['session-two', 'session-one'],
  );

  assert.deepEqual(
    useTaskStore.getState().tasksByProject['project-a'].map(({ id, sortOrder }) => [id, sortOrder]),
    [['task-one', 0], ['task-two', 1]],
  );
  assert.deepEqual(
    useTaskStore.getState().tasksByProject['project-c'].map(({ id, sortOrder }) => [id, sortOrder]),
    [['task-one', 1], ['task-two', 0]],
  );
  assert.deepEqual(
    useSessionStore.getState().projects[0]?.sessions.map(({ id, sortOrder }) => [id, sortOrder]),
    [['session-one', 0], ['session-two', 1]],
  );
  assert.deepEqual(
    useSessionStore.getState().projects[1]?.sessions.map(({ id, sortOrder }) => [id, sortOrder]),
    [['session-one', 1], ['session-two', 0]],
  );
});

test('standalone Session Collection move updates C without rewriting loaded A placement', async () => {
  let requestBody: unknown;
  globalThis.fetch = async (_input, init) => {
    requestBody = JSON.parse(String(init?.body));
    return new Response('{}', { status: 200 });
  };
  const inA = session('shared-session', 'project-a', 0);
  const inC = { ...session('shared-session', 'project-c', 0), collectionId: 'collection-c' };
  useSessionStore.setState({
    ...useSessionStore.getInitialState(),
    projects: [project('project-a', [inA]), project('project-c', [inC])],
  }, true);

  useSessionStore.getState().updateSessionCollection(
    'shared-session',
    'collection-c-next',
    'project-c',
  );
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(useSessionStore.getState().projects[0]?.sessions[0]?.collectionId, undefined);
  assert.equal(
    useSessionStore.getState().projects[1]?.sessions[0]?.collectionId,
    'collection-c-next',
  );
  assert.deepEqual(requestBody, {
    collectionId: 'collection-c-next',
    projectViewId: 'project-c',
  });
});

test('Kanban workflow mutation forwards the visible C appearance for a task-linked Session', () => {
  let forwardedProjectViewId: string | undefined;
  const inA = {
    ...session('shared-session', 'project-a', 0),
    taskId: 'shared-task',
    workflowStatus: 'todo' as const,
  };
  const inC = { ...inA, projectDir: 'project-c' };
  useSessionStore.setState({
    ...useSessionStore.getInitialState(),
    projects: [project('project-a', [inA]), project('project-c', [inC])],
  }, true);
  useTaskStore.setState({
    ...useTaskStore.getInitialState(),
    updateTask: async (_id, _patch, projectViewId) => {
      forwardedProjectViewId = projectViewId;
      return true;
    },
  }, true);

  useSessionStore.getState().updateChatWorkflowStatus(
    'shared-session',
    'in_progress',
    'project-c',
  );

  assert.equal(forwardedProjectViewId, 'project-c');
});
