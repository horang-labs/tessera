import assert from 'node:assert/strict';
import test from 'node:test';
import { useSessionStore } from '@/stores/session-store';
import { useTaskStore } from '@/stores/task-store';
import type { ProjectGroup, UnifiedSession } from '@/types/chat';
import type { TaskEntity, TaskSession } from '@/types/task-entity';

const originalFetch = globalThis.fetch;

function task(projectId: string, projectViewId: string): TaskEntity {
  return {
    id: 'shared-worktree',
    worktreeId: 'wt_shared',
    projectId,
    projectViewId,
    title: 'Shared Worktree',
    workflowStatus: 'todo',
    sortOrder: 0,
    sessions: [taskSession()],
    createdAt: '2026-08-10T00:00:00.000Z',
    updatedAt: '2026-08-10T00:00:00.000Z',
  };
}

function taskSession(): TaskSession {
  return {
    id: 'session-c',
    originProjectId: 'project-a',
    title: 'Shared Session',
    lastModified: '2026-08-10T00:00:00.000Z',
    isRunning: false,
    sortOrder: 0,
  };
}

function session(projectDir: string, collectionId: string): UnifiedSession {
  return {
    id: 'session-c',
    title: 'Shared Session',
    projectDir,
    originProjectId: 'project-a',
    taskId: 'shared-worktree',
    provider: 'codex',
    kind: 'chat',
    status: 'completed',
    workflowStatus: 'todo',
    collectionId,
    isRunning: false,
    hasStarted: true,
    archived: false,
    sortOrder: 0,
    createdAt: '2026-08-10T00:00:00.000Z',
    lastModified: '2026-08-10T00:00:00.000Z',
  };
}

function project(projectDir: string, appearance: UnifiedSession): ProjectGroup {
  return {
    encodedDir: projectDir,
    displayName: projectDir,
    decodedPath: `/${projectDir}`,
    isCurrent: projectDir === 'project-c',
    sessions: [appearance],
    totalSessions: 1,
    allLoaded: true,
    loadedCount: 1,
    nextCursor: null,
    loadBatchIndex: 0,
  };
}

function seedAppearances(): void {
  const inA = task('project-a', 'project-a');
  const inC = task('project-a', 'project-c');
  inA.collectionId = 'collection-a';
  inC.collectionId = 'collection-c';
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
    projects: [
      project('project-a', session('project-a', 'collection-a')),
      project('project-c', session('project-c', 'collection-c')),
    ],
    retainedSessions: {
      'session-c': session('project-c', 'collection-c'),
    },
  }, true);
}

test.afterEach(() => {
  globalThis.fetch = originalFetch;
  useTaskStore.setState(useTaskStore.getInitialState(), true);
  useSessionStore.setState(useSessionStore.getInitialState(), true);
});

test('canonical Task mutations update every cached Project appearance without leaking Collections', async () => {
  const requestBodies: unknown[] = [];
  globalThis.fetch = async (_input, init) => {
    requestBodies.push(JSON.parse(String(init?.body)));
    return new Response('{}', { status: 200 });
  };
  seedAppearances();

  assert.equal(await useTaskStore.getState().updateTask('shared-worktree', {
    title: 'Renamed everywhere',
    workflowStatus: 'done',
  }), true);
  assert.deepEqual(
    Object.values(useTaskStore.getState().tasksByProject).map((tasks) => ({
      title: tasks[0]?.title,
      status: tasks[0]?.workflowStatus,
    })),
    [
      { title: 'Renamed everywhere', status: 'done' },
      { title: 'Renamed everywhere', status: 'done' },
    ],
  );
  assert.deepEqual(
    useSessionStore.getState().projects.map((projectState) =>
      projectState.sessions[0]?.workflowStatus
    ),
    ['done', 'done'],
  );
  assert.equal(
    useSessionStore.getState().retainedSessions['session-c']?.workflowStatus,
    'done',
  );

  assert.equal(await useTaskStore.getState().updateTask('shared-worktree', {
    collectionId: null,
  }), true);
  assert.equal(useTaskStore.getState().tasksByProject['project-a'][0]?.collectionId, undefined);
  assert.equal(useTaskStore.getState().tasksByProject['project-c'][0]?.collectionId, undefined);
  assert.equal(useSessionStore.getState().projects[0]?.sessions[0]?.collectionId, undefined);
  assert.equal(useSessionStore.getState().projects[1]?.sessions[0]?.collectionId, undefined);
  assert.equal(useSessionStore.getState().retainedSessions['session-c']?.collectionId, undefined);
  assert.equal(useTaskStore.getState().tasks[0]?.projectViewId, 'project-c');
  assert.deepEqual(requestBodies[1], { collectionId: null, projectViewId: 'project-c' });
});

test('Collection mutation honors the requested Project appearance over currentProjectId', async () => {
  let requestBody: Record<string, unknown> | undefined;
  globalThis.fetch = async (_input, init) => {
    requestBody = JSON.parse(String(init?.body));
    return new Response('{}', { status: 200 });
  };
  seedAppearances();

  assert.equal(await useTaskStore.getState().updateTask(
    'shared-worktree',
    { collectionId: 'collection-a-next' },
    'project-a',
  ), true);

  assert.equal(
    useTaskStore.getState().tasksByProject['project-a'][0]?.collectionId,
    'collection-a-next',
  );
  assert.equal(useTaskStore.getState().tasksByProject['project-c'][0]?.collectionId, undefined);
  assert.equal(useSessionStore.getState().projects[0]?.sessions[0]?.collectionId, 'collection-a-next');
  assert.equal(useSessionStore.getState().projects[1]?.sessions[0]?.collectionId, undefined);
  assert.equal(useSessionStore.getState().retainedSessions['session-c']?.collectionId, undefined);
  assert.deepEqual(requestBody, {
    collectionId: 'collection-a-next',
    projectViewId: 'project-a',
  });
});

test('failed workflow mutation rolls back every loaded appearance', async () => {
  globalThis.fetch = async (input, init) => {
    if (init?.method === 'PATCH') return new Response('{}', { status: 500 });
    const projectId = new URL(String(input), 'http://localhost').searchParams.get('projectId');
    const restored = task('project-a', projectId ?? 'project-a');
    restored.collectionId = projectId === 'project-c' ? 'collection-c' : 'collection-a';
    return Response.json({ tasks: [restored] });
  };
  seedAppearances();

  assert.equal(await useTaskStore.getState().updateTask('shared-worktree', {
    workflowStatus: 'done',
  }), false);
  assert.deepEqual(
    Object.values(useTaskStore.getState().tasksByProject).map(([appearance]) =>
      appearance.workflowStatus
    ),
    ['todo', 'todo'],
  );
  assert.deepEqual(
    useSessionStore.getState().projects.map((projectState) =>
      projectState.sessions[0]?.workflowStatus
    ),
    ['todo', 'todo'],
  );
  assert.equal(
    useSessionStore.getState().retainedSessions['session-c']?.workflowStatus,
    'todo',
  );
});

test('Todo promotion uses the shared mutation seam for Tasks and Sessions', () => {
  seedAppearances();

  useTaskStore.getState().applyWorkflowStatusPromotions(['shared-worktree']);

  assert.deepEqual(
    Object.values(useTaskStore.getState().tasksByProject).map(([appearance]) =>
      appearance.workflowStatus
    ),
    ['in_progress', 'in_progress'],
  );
  assert.deepEqual(
    useSessionStore.getState().projects.map((projectState) =>
      projectState.sessions[0]?.workflowStatus
    ),
    ['in_progress', 'in_progress'],
  );
  assert.equal(
    useSessionStore.getState().retainedSessions['session-c']?.workflowStatus,
    'in_progress',
  );
});

test('archive removes every cached Project appearance', async () => {
  globalThis.fetch = async () => new Response('{}', { status: 200 });
  seedAppearances();

  assert.equal(await useTaskStore.getState().toggleTaskArchive('shared-worktree', true), true);
  assert.deepEqual(useTaskStore.getState().tasks, []);
  assert.deepEqual(useTaskStore.getState().tasksByProject, {
    'project-a': [],
    'project-c': [],
  });
  for (const appearance of useSessionStore.getState().projects.flatMap(({ sessions }) => sessions)) {
    assert.equal(appearance.archived, true);
    assert.equal(appearance.isReadOnly, true);
  }
  assert.equal(useSessionStore.getState().retainedSessions['session-c']?.archived, true);
  assert.equal(useSessionStore.getState().retainedSessions['session-c']?.isReadOnly, true);
});

test('Worktree deletion removes every cached Project appearance', async () => {
  globalThis.fetch = async () => new Response('{}', { status: 200 });
  seedAppearances();

  assert.equal(await useTaskStore.getState().deleteWorktree('shared-worktree'), true);
  assert.deepEqual(useTaskStore.getState().tasks, []);
  assert.deepEqual(useTaskStore.getState().tasksByProject, {
    'project-a': [],
    'project-c': [],
  });
});
