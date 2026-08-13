import assert from 'node:assert/strict';
import test from 'node:test';
import { handleIncomingServerMessage } from '@/lib/ws/client-message-handlers';
import type { ServerTransportMessage } from '@/lib/ws/message-types';
import { projectViewWorkspaceState } from '@/lib/projects/project-view-workspace-state-client';
import { reconcileActiveSessionSurface } from '@/lib/session/reconcile-active-session-surface';
import { useBoardStore } from '@/stores/board-store';
import { usePanelStore } from '@/stores/panel-store';
import { useSessionStore } from '@/stores/session-store';
import { useTaskStore } from '@/stores/task-store';
import { useTabStore } from '@/stores/tab-store';
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
    workDir: 'project-c',
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
  useBoardStore.setState(useBoardStore.getInitialState(), true);
  usePanelStore.setState(usePanelStore.getInitialState(), true);
  useTaskStore.setState(useTaskStore.getInitialState(), true);
  useSessionStore.setState(useSessionStore.getInitialState(), true);
  useTabStore.setState(useTabStore.getInitialState(), true);
});

test('initial Project hydration restores a saved active Session before fallback', async (t) => {
  const savedSessionId = 'saved-session';
  const storage = new Map([['activeSessionId', savedSessionId]]);
  const originalSessionStorage = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  Object.defineProperty(globalThis, 'sessionStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    },
  });
  t.after(() => {
    if (originalSessionStorage) {
      Object.defineProperty(globalThis, 'sessionStorage', originalSessionStorage);
    } else {
      Reflect.deleteProperty(globalThis, 'sessionStorage');
    }
  });

  globalThis.fetch = async () => Response.json({
    projects: [
      project('project-c'),
      {
        ...project('saved-project', [{
          ...sessionAppearance('saved-project'),
          id: savedSessionId,
        }]),
        isCurrent: false,
      },
    ],
  });

  await useSessionStore.getState().loadProjects();

  assert.equal(useSessionStore.getState().activeSessionId, savedSessionId);
  assert.equal(useSessionStore.getState().didHydrateActiveSession, true);
});

test('initial Project hydration preserves an explicitly restored empty active panel', async () => {
  const restoredTabId = 'restored-empty-tab';
  const autoActivatedTabId = 'auto-activated-terminal-tab';
  useTabStore.setState({
    tabs: [
      { id: restoredTabId, projectDir: null, title: null, isPreview: false },
      { id: autoActivatedTabId, projectDir: null, title: null, isPreview: false },
    ],
    activeTabId: autoActivatedTabId,
    lruTabIds: [autoActivatedTabId, restoredTabId],
  });
  useSessionStore.setState({ activeSessionId: 'background-runtime-race' });
  globalThis.fetch = async () => Response.json({
    projects: [project('project-c')],
  });

  await useSessionStore.getState().loadProjects({
    restoredActiveSessionId: null,
    restoredActiveTabId: restoredTabId,
  });

  assert.equal(useSessionStore.getState().activeSessionId, null);
  assert.equal(useTabStore.getState().activeTabId, restoredTabId);
  assert.equal(useSessionStore.getState().didHydrateActiveSession, true);
});

test('a passive Task reload preserves a manually selected board-only Project', async (t) => {
  const oldProjectId = 'project-c';
  const fixtureProjectId = 'fixture-project';
  let projectLoads = 0;

  useSessionStore.setState(useSessionStore.getInitialState(), true);
  useTaskStore.setState(useTaskStore.getInitialState(), true);
  useBoardStore.setState({
    ...useBoardStore.getInitialState(),
    selectedProjectDir: oldProjectId,
    peekFileDirty: false,
  }, true);
  useTabStore.setState({
    ...useTabStore.getInitialState(),
    tabs: [{ id: 'bootstrap-tab', projectDir: null, title: null, isPreview: false }],
    activeTabId: 'bootstrap-tab',
    lruTabIds: ['bootstrap-tab'],
    projectTabStates: {},
    globalTabState: null,
    currentProjectDir: null,
  }, true);
  usePanelStore.setState({
    ...usePanelStore.getInitialState(),
    activeTabId: 'bootstrap-tab',
    tabPanels: {
      'bootstrap-tab': {
        layout: { type: 'leaf', panelId: 'bootstrap-panel' },
        panels: { 'bootstrap-panel': { id: 'bootstrap-panel', sessionId: null } },
        activePanelId: 'bootstrap-panel',
      },
    },
  }, true);

  globalThis.fetch = async (input) => {
    const url = new URL(String(input), 'http://localhost');
    if (url.pathname === '/api/tasks') {
      return Response.json({ tasks: [] });
    }
    projectLoads += 1;
    return Response.json({
      projects: [
        {
          ...project(oldProjectId),
          displayName: projectLoads === 1 ? 'Old project' : 'Reloaded old project',
        },
        { ...project(fixtureProjectId, []), isCurrent: false },
      ],
    });
  };

  await useSessionStore.getState().loadProjects();
  assert.equal(useSessionStore.getState().activeSessionId, 'session-c');

  useTabStore.getState().switchProject(oldProjectId);
  useTabStore.getState().createTabWithSession('session-c');
  useBoardStore.getState().setSelectedProjectDir(fixtureProjectId);
  useTabStore.getState().switchProject(fixtureProjectId);
  useSessionStore.getState().setActiveSession(null);
  assert.equal(useSessionStore.getState().activeSessionId, null);

  const unsubscribe = useSessionStore.subscribe((state, previousState) => {
    if (state.activeSessionId && state.activeSessionId !== previousState.activeSessionId) {
      reconcileActiveSessionSurface(state.activeSessionId);
    }
  });
  t.after(unsubscribe);

  receive({
    type: 'task_mutated',
    kind: 'updated',
    projectId: fixtureProjectId,
    affectedProjectIds: [fixtureProjectId],
    taskId: 'fixture-task',
    title: 'Renamed fixture task',
  } as ServerTransportMessage);

  await waitFor(() => (
    useSessionStore.getState().projects[0]?.displayName === 'Reloaded old project'
  ));

  assert.deepEqual({
    activeSessionId: useSessionStore.getState().activeSessionId,
    didHydrateActiveSession: useSessionStore.getState().didHydrateActiveSession,
    selectedProjectDir: useBoardStore.getState().selectedProjectDir,
  }, {
    activeSessionId: null,
    didHydrateActiveSession: true,
    selectedProjectDir: fixtureProjectId,
  });
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

test('a remote Task transition applies title, workflow, and preparation before refetch', () => {
  seedAppearances();
  globalThis.fetch = () => new Promise<Response>(() => {});

  receive({
    type: 'task_mutated',
    kind: 'updated',
    projectId: 'project-a',
    taskId: 'shared-worktree',
    sessionId: 'session-c',
    title: 'Renamed remotely',
    workflowStatus: 'in_progress',
    preparationStatus: 'succeeded',
  } as ServerTransportMessage);

  for (const appearance of Object.values(useTaskStore.getState().tasksByProject).flat()) {
    assert.equal(appearance.title, 'Renamed remotely');
    assert.equal(appearance.workflowStatus, 'in_progress');
    assert.equal(appearance.preparationStatus, 'succeeded');
    assert.equal(appearance.sessions[0]?.title, 'Renamed remotely');
  }
  for (const appearance of useSessionStore.getState().projects.flatMap(({ sessions }) => sessions)) {
    assert.equal(appearance.title, 'Renamed remotely');
    assert.equal(appearance.workflowStatus, 'in_progress');
  }
});

test('a remote Task workflow transition updates a Session-only alternate Project View', () => {
  const alternateSession = { ...sessionAppearance('project-c'), taskId: undefined };
  useTaskStore.setState({
    ...useTaskStore.getInitialState(),
    tasks: [],
    tasksByProject: { 'project-c': [] },
    currentProjectId: 'project-c',
    loaded: true,
    loadedProjects: { 'project-c': true },
  }, true);
  useSessionStore.setState({
    ...useSessionStore.getInitialState(),
    projects: [project('project-c', [alternateSession])],
    retainedSessions: { 'session-c': alternateSession },
  }, true);
  globalThis.fetch = () => new Promise<Response>(() => {});

  receive({
    type: 'task_mutated',
    kind: 'updated',
    projectId: 'project-a',
    taskId: 'shared-worktree',
    sessionId: 'session-c',
    workflowStatus: 'in_progress',
  } as ServerTransportMessage);

  assert.equal(useSessionStore.getState().projects[0].sessions[0]?.workflowStatus, 'in_progress');
  assert.equal(useSessionStore.getState().retainedSessions['session-c']?.workflowStatus, 'in_progress');
});

test('an older Project refresh cannot overwrite a newer workflow projection', async () => {
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  let requests = 0;
  const response = (workflowStatus: 'todo' | 'in_progress') => Response.json({
    projects: [{
      ...project('project-c'),
      sessions: [{ ...sessionAppearance('project-c'), workflowStatus }],
    }],
  });
  globalThis.fetch = async () => {
    requests += 1;
    if (requests === 1) {
      await firstGate;
      return response('in_progress');
    }
    return response('todo');
  };

  const older = useSessionStore.getState().loadProjects();
  await waitFor(() => requests === 1);
  const newer = useSessionStore.getState().loadProjects();
  await newer;
  releaseFirst();
  await older;

  assert.equal(useSessionStore.getState().projects[0]?.sessions[0]?.workflowStatus, 'todo');
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

test('the source Session restore materializes Task density in A and C but a direct Session only in C', () => {
  seedAppearances([]);
  useSessionStore.setState({
    projects: [project('project-a', []), project('project-c', [])],
    retainedSessions: {},
  });

  projectViewWorkspaceState.applySessionRestoreMutation({
    session: sessionAppearance('project-c'),
    taskSession: taskSession(),
    affectedProjectIds: ['project-a', 'project-c'],
  });
  assert.deepEqual(
    Object.values(useTaskStore.getState().tasksByProject)
      .map(([appearance]) => appearance.sessions.map(({ id }) => id)),
    [['session-c'], ['session-c']],
  );
  assert.deepEqual(
    useSessionStore.getState().projects.map(({ sessions }) => sessions.map(({ id }) => id)),
    [[], ['session-c']],
  );
  assert.equal(useSessionStore.getState().retainedSessions['session-c']?.projectDir, 'project-c');
});

test('the source Task restore projects zero, one, and many active Sessions into A and C', () => {
  const sessionD = { ...taskSession(), id: 'session-d', title: 'Another Session' };
  for (const sessions of [[], [taskSession()], [taskSession(), sessionD]]) {
    seedAppearances([]);
    useTaskStore.setState({
      tasks: [],
      tasksByProject: { 'project-a': [], 'project-c': [] },
    });
    useSessionStore.setState({
      projects: [project('project-a', []), project('project-c', [])],
      retainedSessions: {},
    });

    projectViewWorkspaceState.applyTaskRestoreMutation({
      task: taskAppearance('project-a', sessions),
      affectedProjectIds: ['project-a', 'project-c'],
    });

    const expectedIds = sessions.map(({ id }) => id);
    assert.deepEqual(
      Object.values(useTaskStore.getState().tasksByProject)
        .map(([appearance]) => appearance.sessions.map(({ id }) => id)),
      [expectedIds, expectedIds],
    );
    assert.deepEqual(
      useSessionStore.getState().projects.map((view) => view.sessions.map(({ id }) => id)),
      [[], expectedIds],
    );
    assert.deepEqual(Object.keys(useSessionStore.getState().retainedSessions), expectedIds);
  }
});
