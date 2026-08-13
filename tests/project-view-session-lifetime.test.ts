import assert from 'node:assert/strict';
import test, { beforeEach } from 'node:test';

import { handleIncomingServerMessage } from '@/lib/ws/client-message-handlers';
import type { ServerTransportMessage } from '@/lib/ws/message-types';
import { resetPendingTerminalReboundsForTests } from '@/lib/terminal/terminal-session-rebound-reservations';
import { buildWorkspaceFileSessionId } from '@/lib/workspace-tabs/special-session';
import { useBoardStore } from '@/stores/board-store';
import { usePanelStore } from '@/stores/panel-store';
import { useSessionStore } from '@/stores/session-store';
import { useTabStore } from '@/stores/tab-store';
import type { ProjectGroup, UnifiedSession } from '@/types/chat';
import { projectViewWorkspaceState } from '@/lib/projects/project-view-workspace-state-client';

const SESSION_ID = 'project-view-lifetime-session';

function session(kind: UnifiedSession['kind'] = 'chat'): UnifiedSession {
  return {
    id: SESSION_ID,
    title: 'Retained conversation',
    projectDir: 'project-a',
    originProjectId: 'project-a',
    workDir: '/repository-a',
    provider: 'codex',
    kind,
    status: kind === 'terminal' ? 'running' : 'completed',
    isRunning: kind === 'terminal',
    hasStarted: true,
    archived: false,
    sortOrder: 0,
    createdAt: '2026-08-12T00:00:00.000Z',
    lastModified: '2026-08-12T01:00:00.000Z',
  };
}

function project(projectDir: string, sessions: UnifiedSession[]): ProjectGroup {
  return {
    encodedDir: projectDir,
    displayName: projectDir,
    decodedPath: `/repository-${projectDir.at(-1)}`,
    isCurrent: projectDir === 'project-a',
    sessions,
    totalSessions: sessions.length,
    allLoaded: true,
    loadedCount: sessions.length,
    nextCursor: null,
    loadBatchIndex: 0,
  };
}

function receive(msg: ServerTransportMessage): void {
  handleIncomingServerMessage({
    msg,
    providersListCallbacks: new Map(),
    cliStatusCallbacks: new Map(),
    wasReconnect: false,
  });
}

function openThenSnapshot(source: UnifiedSession): void {
  useSessionStore.setState({
    ...useSessionStore.getInitialState(),
    projects: [project('project-a', [source]), project('project-c', [])],
  });
  useTabStore.getState().switchProject('project-a');
  useTabStore.getState().createTabWithSession(source.id);
  useTabStore.getState().switchProject('project-c');
}

async function refreshWithoutSession(t: test.TestContext): Promise<void> {
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({
    projects: [project('project-a', []), project('project-c', [])],
  }), { status: 200, headers: { 'content-type': 'application/json' } }));
  await useSessionStore.getState().loadProjects();
}

beforeEach(() => {
  resetPendingTerminalReboundsForTests();
  useBoardStore.setState({
    ...useBoardStore.getInitialState(),
    selectedProjectDir: 'project-a',
    peekFileDirty: false,
  });
  useTabStore.setState({
    ...useTabStore.getInitialState(),
    tabs: [{ id: 'bootstrap-tab', projectDir: null, title: null, isPreview: false }],
    activeTabId: 'bootstrap-tab',
    lruTabIds: ['bootstrap-tab'],
    projectTabStates: {},
    globalTabState: null,
    currentProjectDir: null,
  });
  usePanelStore.setState({
    activeTabId: 'bootstrap-tab',
    tabPanels: {
      'bootstrap-tab': {
        layout: { type: 'leaf', panelId: 'bootstrap-panel' },
        panels: { 'bootstrap-panel': { id: 'bootstrap-panel', sessionId: null } },
        activePanelId: 'bootstrap-panel',
      },
    },
  });
});

test('Project refresh retains a Session referenced by an inactive tab snapshot', async (t) => {
  openThenSnapshot(session());
  await refreshWithoutSession(t);

  assert.equal(projectViewWorkspaceState.resolveSession(SESSION_ID)?.title, 'Retained conversation');
  useTabStore.getState().switchProject('project-a');
  assert.ok(useTabStore.getState().findSessionLocation(SESSION_ID));
});

test('retention lasts until tab snapshots and Peek both release the Session', async (t) => {
  openThenSnapshot(session());
  useBoardStore.getState().openSessionPeek(SESSION_ID);
  await refreshWithoutSession(t);

  useTabStore.getState().switchProject('project-a');
  const location = useTabStore.getState().findSessionLocation(SESSION_ID);
  assert.ok(location);
  useTabStore.getState().closeTab(location.tabId);
  useTabStore.getState().switchProject('project-c');
  await useSessionStore.getState().loadProjects();
  assert.ok(projectViewWorkspaceState.resolveSession(SESSION_ID));

  assert.equal(useBoardStore.getState().closeSessionPeek(), true);
  await useSessionStore.getState().loadProjects();
  assert.equal(projectViewWorkspaceState.resolveSession(SESSION_ID), undefined);
});

test('a stale saved copy of a materialized tab does not extend retention', async (t) => {
  openThenSnapshot(session());
  useTabStore.getState().switchProject('project-a');
  const location = useTabStore.getState().findSessionLocation(SESSION_ID);
  assert.ok(location);
  usePanelStore.getState().assignSessionInTab(location.tabId, location.panelId, null);

  await refreshWithoutSession(t);

  assert.equal(projectViewWorkspaceState.resolveSession(SESSION_ID), undefined);
});

test('a snapshotted file tab retains and retires with its source Session', async (t) => {
  const source = session();
  const fileSessionId = buildWorkspaceFileSessionId(source.id, 'file', 'README.md');
  useSessionStore.setState({
    ...useSessionStore.getInitialState(),
    projects: [project('project-a', [source]), project('project-c', [])],
  });
  useTabStore.getState().switchProject('project-a');
  useTabStore.getState().createTabWithSession(fileSessionId);
  useTabStore.getState().switchProject('project-c');
  await refreshWithoutSession(t);
  assert.ok(projectViewWorkspaceState.resolveSession(SESSION_ID));

  useSessionStore.getState().removeSession(SESSION_ID);

  assert.equal(useTabStore.getState().findSessionSurface(fileSessionId), null);
});

for (const lifecycle of ['stop', 'archive', 'delete'] as const) {
  test(`${lifecycle} retires an inactive Project tab snapshot`, async (t) => {
    openThenSnapshot(session());
    useBoardStore.getState().openSessionPeek(SESSION_ID);
    if (lifecycle === 'stop') {
      receive({ type: 'session_stopped', sessionId: SESSION_ID });
    } else if (lifecycle === 'delete') {
      receive({ type: 'session_closed', sessionId: SESSION_ID });
    } else {
      t.mock.method(globalThis, 'fetch', async () => new Response('{}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));
      useSessionStore.getState().toggleArchive(SESSION_ID, true);
      await new Promise<void>((resolve) => setImmediate(resolve));
    }

    assert.equal(useTabStore.getState().findSessionSurface(SESSION_ID), null);
    assert.equal(useBoardStore.getState().peekSessionId, null);
  });
}

test('a cold runtime snapshot preserves a retained terminal tab for automatic resume', async (t) => {
  openThenSnapshot(session('terminal'));
  await refreshWithoutSession(t);

  receive({
    type: 'terminal_session_runtime_snapshot',
    activeSessionIds: [],
    reboundSessions: [],
  });

  assert.ok(useTabStore.getState().findSessionSurface(SESSION_ID));
  assert.equal(projectViewWorkspaceState.resolveSession(SESSION_ID)?.isRunning, false);
});

test('reconnect preserves a retained terminal snapshot reserved for rebound', async (t) => {
  openThenSnapshot(session('terminal'));
  await refreshWithoutSession(t);
  useSessionStore.setState({ loadProjects: async () => {} });

  receive({
    type: 'terminal_session_runtime_snapshot',
    activeSessionIds: ['rebound-destination'],
    reboundSessions: [{
      terminalId: `session-${SESSION_ID}`,
      previousSessionId: SESSION_ID,
      sessionId: 'rebound-destination',
    }],
  });

  assert.ok(useTabStore.getState().findSessionSurface(SESSION_ID));
});
