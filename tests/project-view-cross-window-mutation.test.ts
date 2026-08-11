import assert from 'node:assert/strict';
import test from 'node:test';
import { handleIncomingServerMessage } from '@/lib/ws/client-message-handlers';
import type { ServerTransportMessage } from '@/lib/ws/message-types';
import { projectViewWorkspaceState } from '@/lib/projects/project-view-workspace-state-client';
import { useSessionStore } from '@/stores/session-store';
import { useTaskStore } from '@/stores/task-store';
import type { ProjectGroup, UnifiedSession } from '@/types/chat';
import type { TaskEntity, TaskSession } from '@/types/task-entity';

const originalFetch = globalThis.fetch;

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

function taskAppearance(projectViewId: string, sessions = [taskSession()]): TaskEntity {
  return {
    id: 'shared-worktree',
    worktreeId: 'wt-shared',
    projectId: 'project-a',
    projectViewId,
    title: 'Shared Worktree',
    workflowStatus: 'todo',
    preparationStatus: 'running',
    sortOrder: 0,
    sessions,
    createdAt: '2026-08-10T00:00:00.000Z',
    updatedAt: '2026-08-10T00:00:00.000Z',
  };
}

function sessionAppearance(projectDir: string): UnifiedSession {
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
    isRunning: false,
    hasStarted: true,
    archived: false,
    sortOrder: 0,
    createdAt: '2026-08-10T00:00:00.000Z',
    lastModified: '2026-08-10T00:00:00.000Z',
  };
}

function project(projectDir: string, sessions = [sessionAppearance(projectDir)]): ProjectGroup {
  return {
    encodedDir: projectDir,
    displayName: projectDir,
    decodedPath: `/${projectDir}`,
    isCurrent: projectDir === 'project-c',
    sessions,
    totalSessions: sessions.length,
    allLoaded: true,
    loadedCount: sessions.length,
    nextCursor: null,
    loadBatchIndex: 0,
  };
}

function seedAppearances(sessions = [taskSession()]): void {
  const inA = taskAppearance('project-a', sessions);
  const inC = taskAppearance('project-c', sessions);
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
    retainedSessions: { 'session-c': sessionAppearance('project-c') },
  }, true);
}

function receive(msg: ServerTransportMessage): void {
  handleIncomingServerMessage({
    msg,
    providersListCallbacks: new Map(),
    cliStatusCallbacks: new Map(),
    wasReconnect: false,
  });
}

async function waitFor(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (check()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
  assert.fail('workspace mutation refresh did not settle');
}

test.afterEach(() => {
  globalThis.fetch = originalFetch;
  useTaskStore.setState(useTaskStore.getInitialState(), true);
  useSessionStore.setState(useSessionStore.getInitialState(), true);
});

test('a Task mutation from another window refreshes its A and C appearances', async () => {
  const requestedProjects: string[] = [];
  seedAppearances();
  globalThis.fetch = async (input) => {
    const url = new URL(String(input), 'http://localhost');
    if (url.pathname === '/api/tasks') {
      const projectId = url.searchParams.get('projectId')!;
      requestedProjects.push(projectId);
      return Response.json({ tasks: [{
        ...taskAppearance(projectId),
        title: 'Renamed remotely',
        workflowStatus: 'done',
        preparationStatus: 'succeeded',
      }] });
    }
    return Response.json({
      projects: ['project-a', 'project-c'].map((projectId) => project(projectId, [{
        ...sessionAppearance(projectId),
        title: 'Renamed remotely',
        workflowStatus: 'done',
      }])),
    });
  };

  receive({
    type: 'task_mutated',
    kind: 'updated',
    projectId: 'project-a',
    taskId: 'shared-worktree',
  } as ServerTransportMessage);

  await waitFor(() => (
    requestedProjects.length === 2
    && Object.values(useTaskStore.getState().tasksByProject)
      .every(([appearance]) => appearance.title === 'Renamed remotely')
    && useSessionStore.getState().projects
      .every(({ sessions }) => sessions[0]?.title === 'Renamed remotely')
  ));
  assert.deepEqual(requestedProjects.sort(), ['project-a', 'project-c']);
  for (const appearance of Object.values(useTaskStore.getState().tasksByProject).flat()) {
    assert.equal(appearance.title, 'Renamed remotely');
    assert.equal(appearance.workflowStatus, 'done');
    assert.equal(appearance.preparationStatus, 'succeeded');
  }
  assert.deepEqual(
    useSessionStore.getState().projects.map(({ sessions }) => sessions[0]?.title),
    ['Renamed remotely', 'Renamed remotely'],
  );
});

test('restoring a task Session refreshes zero-to-one density in A and C', async () => {
  const requestedProjects: string[] = [];
  seedAppearances([]);
  useTaskStore.setState({
    tasks: [],
    tasksByProject: { 'project-a': [], 'project-c': [] },
  });
  useSessionStore.setState({
    projects: [project('project-a', []), project('project-c', [])],
    retainedSessions: {},
  });
  globalThis.fetch = async (input) => {
    const url = new URL(String(input), 'http://localhost');
    if (url.pathname === '/api/tasks') {
      const projectId = url.searchParams.get('projectId')!;
      requestedProjects.push(projectId);
      return Response.json({ tasks: [taskAppearance(projectId)] });
    }
    return Response.json({
      projects: ['project-a', 'project-c'].map((projectId) => project(projectId)),
    });
  };

  receive({
    type: 'session_mutated',
    kind: 'updated',
    projectId: 'project-a',
    sessionId: 'session-c',
    taskId: 'shared-worktree',
    affectedProjectIds: ['project-a', 'project-c'],
  } as ServerTransportMessage);

  await waitFor(() => (
    requestedProjects.length === 2
    && Object.values(useTaskStore.getState().tasksByProject)
      .every(([appearance]) => appearance?.sessions.length === 1)
  ));
  assert.deepEqual(requestedProjects.sort(), ['project-a', 'project-c']);
  assert.deepEqual(
    Object.values(useTaskStore.getState().tasksByProject)
      .map(([appearance]) => appearance.sessions.map(({ id }) => id)),
    [['session-c'], ['session-c']],
  );
});

test('a remote Task archive makes every retained appearance read-only before refetch', async () => {
  let releaseRequests!: () => void;
  const requestsReleased = new Promise<void>((resolve) => {
    releaseRequests = resolve;
  });
  const requestedUrls: string[] = [];
  seedAppearances();
  globalThis.fetch = async (input) => {
    const url = new URL(String(input), 'http://localhost');
    requestedUrls.push(url.href);
    await requestsReleased;
    return url.pathname === '/api/tasks'
      ? Response.json({ tasks: [] })
      : Response.json({
          projects: ['project-a', 'project-c'].map((projectId) => project(projectId, [])),
        });
  };

  receive({
    type: 'task_mutated',
    kind: 'updated',
    projectId: 'project-a',
    taskId: 'shared-worktree',
    archived: true,
  } as ServerTransportMessage);

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

  releaseRequests();
  await waitFor(() => requestedUrls.length === 3);
});

test('a remote Session archive updates A and C density plus retained read-only state', async () => {
  let releaseRequests!: () => void;
  const requestsReleased = new Promise<void>((resolve) => {
    releaseRequests = resolve;
  });
  const requestedUrls: string[] = [];
  seedAppearances();
  globalThis.fetch = async (input) => {
    const url = new URL(String(input), 'http://localhost');
    requestedUrls.push(url.href);
    await requestsReleased;
    return url.pathname === '/api/tasks'
      ? Response.json({ tasks: [taskAppearance(url.searchParams.get('projectId')!, [])] })
      : Response.json({
          projects: ['project-a', 'project-c'].map((projectId) => project(projectId, [])),
        });
  };

  receive({
    type: 'session_mutated',
    kind: 'updated',
    projectId: 'project-a',
    sessionId: 'session-c',
    taskId: 'shared-worktree',
    archived: true,
  } as ServerTransportMessage);

  assert.deepEqual(
    Object.values(useTaskStore.getState().tasksByProject)
      .map(([appearance]) => appearance.sessions),
    [[], []],
  );
  assert.equal(useSessionStore.getState().retainedSessions['session-c']?.archived, true);
  assert.equal(useSessionStore.getState().retainedSessions['session-c']?.isReadOnly, true);

  releaseRequests();
  await waitFor(() => requestedUrls.length === 3);
});

test('the source restore transition materializes Session and Task density in A and C', () => {
  seedAppearances([]);
  useSessionStore.setState({
    projects: [project('project-a', []), project('project-c', [])],
    retainedSessions: {},
  });

  projectViewWorkspaceState.applySessionRestoreMutation({
    session: sessionAppearance('project-a'),
    taskSession: taskSession(),
    affectedProjectIds: ['project-a', 'project-c'],
  });
  assert.deepEqual(
    Object.values(useTaskStore.getState().tasksByProject)
      .map(([appearance]) => appearance.sessions.map(({ id }) => id)),
    [['session-c'], ['session-c']],
  );

  useTaskStore.setState({
    tasks: [],
    tasksByProject: { 'project-a': [], 'project-c': [] },
  });
  useSessionStore.setState({
    projects: [project('project-a', []), project('project-c', [])],
    retainedSessions: {},
  });
  projectViewWorkspaceState.applyTaskRestoreMutation({
    task: taskAppearance('project-a'),
    affectedProjectIds: ['project-a', 'project-c'],
  });
  assert.deepEqual(
    Object.values(useTaskStore.getState().tasksByProject)
      .map(([appearance]) => appearance.sessions.map(({ id }) => id)),
    [['session-c'], ['session-c']],
  );
});
