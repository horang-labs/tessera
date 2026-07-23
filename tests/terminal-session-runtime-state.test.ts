import assert from 'node:assert/strict';
import test, { beforeEach } from 'node:test';
import { handleIncomingServerMessage } from '@/lib/ws/client-message-handlers';
import type { ServerTransportMessage } from '@/lib/ws/message-types';
import { isTurnInFlight, useChatStore } from '@/stores/chat-store';
import { useSessionStore } from '@/stores/session-store';
import { useTaskStore } from '@/stores/task-store';
import { useTerminalSessionStore } from '@/stores/terminal-session-store';
import { usePanelStore } from '@/stores/panel-store';
import { useTabStore } from '@/stores/tab-store';
import type { ProjectGroup, UnifiedSession } from '@/types/chat';

const SESSION_ID = 'terminal-session-a';

function terminalSession(id = SESSION_ID, isRunning = false): UnifiedSession {
  return {
    id,
    title: 'PTY session',
    projectDir: '/workspace',
    workDir: '/workspace',
    kind: 'terminal',
    provider: 'claude-code',
    isRunning,
    hasStarted: isRunning,
    status: isRunning ? 'running' : 'stopped',
    createdAt: '2026-07-14T00:00:00.000Z',
    lastModified: '2026-07-14T00:00:00.000Z',
  };
}

function guiSession(id: string, isRunning = false): UnifiedSession {
  return {
    ...terminalSession(id, isRunning),
    title: 'GUI session',
    kind: 'chat',
    status: isRunning ? 'running' : 'completed',
  };
}

function project(...sessions: UnifiedSession[]): ProjectGroup {
  return {
    encodedDir: '/workspace',
    displayName: 'workspace',
    decodedPath: '/workspace',
    isCurrent: true,
    sessions,
    totalSessions: sessions.length,
    allLoaded: true,
    loadedCount: 1,
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

beforeEach(() => {
  useChatStore.setState({ turnInFlightBySession: {} });
  useTerminalSessionStore.setState({ bySessionId: {} });
  useSessionStore.setState({
    ...useSessionStore.getInitialState(),
    projects: [project(terminalSession())],
    activeSessionId: null,
    runningWorkflowSessionIds: new Set(),
  });
  useTaskStore.setState({
    tasks: [],
    tasksByProject: {},
    currentProjectId: null,
  });
  useTabStore.setState({ tabs: [], activeTabId: null, lruTabIds: [] });
  usePanelStore.setState({ activeTabId: null, tabPanels: {} });
});

test('PTY UserPromptSubmit marks only the terminal state as processing', () => {
  receive({
    type: 'terminal_session_runtime',
    sessionId: SESSION_ID,
    running: true,
  } as ServerTransportMessage);

  receive({
    type: 'session_state',
    sessionId: SESSION_ID,
    terminalId: `session-${SESSION_ID}`,
    status: 'running',
    hookEvent: 'UserPromptSubmit',
  });

  assert.equal(
    useTerminalSessionStore.getState().bySessionId[SESSION_ID]?.status,
    'running',
  );
  assert.equal(isTurnInFlight(useChatStore.getState(), SESSION_ID), false);
  assert.equal(useSessionStore.getState().getSession(SESSION_ID)?.isRunning, true);
});

test('PTY interrupt fallback clears the menu processing indicator', () => {
  receive({
    type: 'session_state',
    sessionId: SESSION_ID,
    terminalId: `session-${SESSION_ID}`,
    status: 'running',
    hookEvent: 'UserPromptSubmit',
  });
  receive({
    type: 'session_state',
    sessionId: SESSION_ID,
    terminalId: `session-${SESSION_ID}`,
    status: 'idle',
    hookEvent: 'InterruptFallback',
  });

  assert.equal(
    useTerminalSessionStore.getState().bySessionId[SESSION_ID]?.status,
    'idle',
  );
  assert.equal(isTurnInFlight(useChatStore.getState(), SESSION_ID), false);
});

test('PTY turn start pins an open preview tab', () => {
  const tabId = 'terminal-preview-tab';
  const panelId = 'terminal-preview-panel';
  useTabStore.setState({
    tabs: [{ id: tabId, projectDir: '/workspace', title: null, isPreview: true }],
    activeTabId: tabId,
    lruTabIds: [tabId],
  });
  usePanelStore.setState({
    activeTabId: tabId,
    tabPanels: {
      [tabId]: {
        layout: { type: 'leaf', panelId },
        panels: { [panelId]: { id: panelId, sessionId: SESSION_ID } },
        activePanelId: panelId,
      },
    },
  });

  receive({
    type: 'terminal_session_runtime',
    sessionId: SESSION_ID,
    running: true,
  } as ServerTransportMessage);
  receive({
    type: 'session_state',
    sessionId: SESSION_ID,
    terminalId: `session-${SESSION_ID}`,
    status: 'running',
    hookEvent: 'UserPromptSubmit',
  });

  assert.equal(useTabStore.getState().tabs[0]?.isPreview, false);
});

test('GUI session-list reconciliation cannot clear PTY processing state', () => {
  receive({
    type: 'terminal_session_runtime',
    sessionId: SESSION_ID,
    running: true,
  } as ServerTransportMessage);

  receive({
    type: 'session_state',
    sessionId: SESSION_ID,
    terminalId: `session-${SESSION_ID}`,
    status: 'running',
    hookEvent: 'UserPromptSubmit',
  });

  receive({
    type: 'session_list',
    sessions: [{
      id: SESSION_ID,
      status: 'running',
      isGenerating: false,
      createdAt: '2026-07-14T00:00:00.000Z',
      activeInteractivePrompt: null,
      todoSnapshot: [],
    }],
    titleGeneratingSessionIds: [],
  });

  assert.equal(
    useTerminalSessionStore.getState().bySessionId[SESSION_ID]?.status,
    'running',
  );
  assert.equal(isTurnInFlight(useChatStore.getState(), SESSION_ID), false);
});

test('PTY runtime liveness remains active across completed turns', () => {
  receive({
    type: 'terminal_session_runtime',
    sessionId: SESSION_ID,
    running: true,
  } as ServerTransportMessage);
  assert.equal(useSessionStore.getState().getSession(SESSION_ID)?.isRunning, true);

  receive({
    type: 'session_state',
    sessionId: SESSION_ID,
    terminalId: `session-${SESSION_ID}`,
    status: 'running',
    hookEvent: 'UserPromptSubmit',
  });
  assert.equal(
    useTerminalSessionStore.getState().bySessionId[SESSION_ID]?.status,
    'running',
  );
  assert.equal(isTurnInFlight(useChatStore.getState(), SESSION_ID), false);

  receive({
    type: 'session_state',
    sessionId: SESSION_ID,
    terminalId: `session-${SESSION_ID}`,
    status: 'completed',
    hookEvent: 'Stop',
  });
  assert.equal(
    useTerminalSessionStore.getState().bySessionId[SESSION_ID]?.status,
    'completed',
  );
  assert.equal(isTurnInFlight(useChatStore.getState(), SESSION_ID), false);
  assert.equal(useSessionStore.getState().getSession(SESSION_ID)?.isRunning, true);

  receive({
    type: 'terminal_session_runtime',
    sessionId: SESSION_ID,
    running: false,
  } as ServerTransportMessage);
  const stopped = useSessionStore.getState().getSession(SESSION_ID);
  assert.equal(stopped?.isRunning, false);
  assert.equal(stopped?.status, 'stopped');
});

test('PTY runtime exit closes a retained single-panel session tab', () => {
  const tabId = 'retained-terminal-tab';
  const panelId = 'retained-terminal-panel';
  useTabStore.setState({
    tabs: [{ id: tabId, projectDir: '/workspace', title: null, isPreview: false }],
    activeTabId: tabId,
    lruTabIds: [tabId],
  });
  usePanelStore.setState({
    activeTabId: tabId,
    tabPanels: {
      [tabId]: {
        layout: { type: 'leaf', panelId },
        panels: { [panelId]: { id: panelId, sessionId: SESSION_ID } },
        activePanelId: panelId,
      },
    },
  });

  receive({
    type: 'terminal_session_runtime',
    sessionId: SESSION_ID,
    running: true,
  } as ServerTransportMessage);
  receive({
    type: 'terminal_session_runtime',
    sessionId: SESSION_ID,
    running: false,
  } as ServerTransportMessage);

  assert.equal(useTabStore.getState().tabs.some((tab) => tab.id === tabId), false);
  assert.equal(useTabStore.getState().findSessionLocation(SESSION_ID), null);
});

test('PTY runtime exit removes its panel without discarding unrelated panels', () => {
  const tabId = 'multi-panel-terminal-tab';
  const terminalPanelId = 'terminal-panel';
  const siblingPanelId = 'sibling-panel';
  useTabStore.setState({
    tabs: [{ id: tabId, projectDir: '/workspace', title: null, isPreview: false }],
    activeTabId: tabId,
    lruTabIds: [tabId],
  });
  usePanelStore.setState({
    activeTabId: tabId,
    tabPanels: {
      [tabId]: {
        layout: {
          type: 'hsplit',
          children: [
            { type: 'leaf', panelId: terminalPanelId },
            { type: 'leaf', panelId: siblingPanelId },
          ],
          ratio: 0.5,
        },
        panels: {
          [terminalPanelId]: { id: terminalPanelId, sessionId: SESSION_ID },
          [siblingPanelId]: { id: siblingPanelId, sessionId: 'sibling-session' },
        },
        activePanelId: terminalPanelId,
      },
    },
  });

  receive({
    type: 'terminal_session_runtime',
    sessionId: SESSION_ID,
    running: false,
  } as ServerTransportMessage);

  assert.equal(useTabStore.getState().tabs.some((tab) => tab.id === tabId), true);
  assert.equal(
    usePanelStore.getState().tabPanels[tabId]?.panels[siblingPanelId]?.sessionId,
    'sibling-session',
  );
  assert.equal(usePanelStore.getState().tabPanels[tabId]?.panels[terminalPanelId], undefined);
  assert.equal(useTabStore.getState().findSessionLocation(SESSION_ID), null);
});

test('PTY session rebound keeps the panel and transfers its session ownership atomically', () => {
  const childSessionId = 'terminal-session-child';
  const tabId = 'rebound-terminal-tab';
  const panelId = 'rebound-terminal-panel';
  useSessionStore.setState({
    projects: [project(terminalSession(SESSION_ID, true), terminalSession(childSessionId))],
  });
  useTabStore.setState({
    tabs: [{ id: tabId, projectDir: '/workspace', title: null, isPreview: false }],
    activeTabId: tabId,
    lruTabIds: [tabId],
  });
  usePanelStore.setState({
    activeTabId: tabId,
    tabPanels: {
      [tabId]: {
        layout: { type: 'leaf', panelId },
        panels: { [panelId]: { id: panelId, sessionId: SESSION_ID } },
        activePanelId: panelId,
      },
    },
  });

  receive({
    type: 'terminal_session_rebound',
    previousSessionId: SESSION_ID,
    sessionId: childSessionId,
    terminalId: `session-${SESSION_ID}`,
  } as ServerTransportMessage);

  assert.equal(useTabStore.getState().tabs.some((tab) => tab.id === tabId), true);
  assert.equal(useTabStore.getState().findSessionLocation(SESSION_ID), null);
  assert.deepEqual(
    useTabStore.getState().findSessionLocation(childSessionId),
    { tabId, panelId },
  );
  assert.equal(useSessionStore.getState().getSession(SESSION_ID)?.isRunning, false);
  assert.equal(useSessionStore.getState().getSession(childSessionId)?.isRunning, true);
});

test('PTY session rebound waits for the child menu row before switching the visible panel', async (t) => {
  const childSessionId = 'terminal-session-delayed-child';
  const tabId = 'delayed-rebound-tab';
  const panelId = 'delayed-rebound-panel';
  let releaseLoad!: () => void;
  const loadGate = new Promise<void>((resolve) => { releaseLoad = resolve; });
  const originalLoadProjects = useSessionStore.getState().loadProjects;
  t.after(() => useSessionStore.setState({ loadProjects: originalLoadProjects }));
  useSessionStore.setState({
    projects: [project(terminalSession(SESSION_ID, true))],
    loadProjects: async () => {
      await loadGate;
      useSessionStore.setState({
        projects: [project(terminalSession(SESSION_ID), terminalSession(childSessionId, true))],
      });
    },
  });
  useTabStore.setState({
    tabs: [{ id: tabId, projectDir: '/workspace', title: null, isPreview: false }],
    activeTabId: tabId,
    lruTabIds: [tabId],
  });
  usePanelStore.setState({
    activeTabId: tabId,
    tabPanels: {
      [tabId]: {
        layout: { type: 'leaf', panelId },
        panels: { [panelId]: { id: panelId, sessionId: SESSION_ID } },
        activePanelId: panelId,
      },
    },
  });

  receive({
    type: 'terminal_session_rebound',
    previousSessionId: SESSION_ID,
    sessionId: childSessionId,
    terminalId: `session-${SESSION_ID}`,
  });
  assert.deepEqual(useTabStore.getState().findSessionLocation(SESSION_ID), { tabId, panelId });
  assert.equal(useTabStore.getState().findSessionLocation(childSessionId), null);

  releaseLoad();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(useTabStore.getState().findSessionLocation(SESSION_ID), null);
  assert.deepEqual(useTabStore.getState().findSessionLocation(childSessionId), { tabId, panelId });
});

test('PTY runtime snapshot repairs a rebound missed while the client was disconnected', () => {
  const childSessionId = 'terminal-session-reconnected-child';
  const tabId = 'reconnected-rebound-tab';
  const panelId = 'reconnected-rebound-panel';
  useSessionStore.setState({
    projects: [project(terminalSession(SESSION_ID, true), terminalSession(childSessionId))],
  });
  useTabStore.setState({
    tabs: [{ id: tabId, projectDir: '/workspace', title: null, isPreview: false }],
    activeTabId: tabId,
    lruTabIds: [tabId],
  });
  usePanelStore.setState({
    activeTabId: tabId,
    tabPanels: {
      [tabId]: {
        layout: { type: 'leaf', panelId },
        panels: { [panelId]: { id: panelId, sessionId: SESSION_ID } },
        activePanelId: panelId,
      },
    },
  });

  receive({
    type: 'terminal_session_runtime_snapshot',
    activeSessionIds: [childSessionId],
    reboundSessions: [{
      previousSessionId: SESSION_ID,
      sessionId: childSessionId,
      terminalId: `session-${SESSION_ID}`,
    }],
  });

  assert.equal(useTabStore.getState().tabs.some((tab) => tab.id === tabId), true);
  assert.deepEqual(useTabStore.getState().findSessionLocation(childSessionId), { tabId, panelId });
});

test('delayed reconnect rebound keeps the source panel until the child row loads', async (t) => {
  const childSessionId = 'snapshot-delayed-child';
  const tabId = 'snapshot-delayed-tab';
  const panelId = 'snapshot-delayed-panel';
  let releaseLoad!: () => void;
  const loadGate = new Promise<void>((resolve) => { releaseLoad = resolve; });
  const originalLoadProjects = useSessionStore.getState().loadProjects;
  t.after(() => useSessionStore.setState({ loadProjects: originalLoadProjects }));
  useSessionStore.setState({
    projects: [project(terminalSession(SESSION_ID, true))],
    loadProjects: async () => {
      await loadGate;
      useSessionStore.setState({
        projects: [project(terminalSession(SESSION_ID), terminalSession(childSessionId, true))],
      });
    },
  });
  useTabStore.setState({
    tabs: [{ id: tabId, projectDir: '/workspace', title: null, isPreview: false }],
    activeTabId: tabId,
    lruTabIds: [tabId],
  });
  usePanelStore.setState({
    activeTabId: tabId,
    tabPanels: {
      [tabId]: {
        layout: { type: 'leaf', panelId },
        panels: { [panelId]: { id: panelId, sessionId: SESSION_ID } },
        activePanelId: panelId,
      },
    },
  });

  receive({
    type: 'terminal_session_runtime_snapshot',
    activeSessionIds: [childSessionId],
    reboundSessions: [{
      previousSessionId: SESSION_ID,
      sessionId: childSessionId,
      terminalId: `session-${SESSION_ID}`,
    }],
  });
  assert.deepEqual(useTabStore.getState().findSessionLocation(SESSION_ID), { tabId, panelId });

  releaseLoad();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(useTabStore.getState().findSessionLocation(childSessionId), { tabId, panelId });
});

test('rebound destination exit during menu load retires the source and ignores the late load', async (t) => {
  const childSessionId = 'exited-delayed-child';
  const tabId = 'exited-delayed-tab';
  const panelId = 'exited-delayed-panel';
  let releaseLoad!: () => void;
  const loadGate = new Promise<void>((resolve) => { releaseLoad = resolve; });
  const originalLoadProjects = useSessionStore.getState().loadProjects;
  t.after(() => useSessionStore.setState({ loadProjects: originalLoadProjects }));
  useSessionStore.setState({
    projects: [project(terminalSession(SESSION_ID, true))],
    loadProjects: async () => {
      await loadGate;
      useSessionStore.setState({
        projects: [project(terminalSession(SESSION_ID), terminalSession(childSessionId))],
      });
    },
  });
  useTabStore.setState({
    tabs: [{ id: tabId, projectDir: '/workspace', title: null, isPreview: false }],
    activeTabId: tabId,
    lruTabIds: [tabId],
  });
  usePanelStore.setState({
    activeTabId: tabId,
    tabPanels: {
      [tabId]: {
        layout: { type: 'leaf', panelId },
        panels: { [panelId]: { id: panelId, sessionId: SESSION_ID } },
        activePanelId: panelId,
      },
    },
  });

  receive({
    type: 'terminal_session_rebound',
    previousSessionId: SESSION_ID,
    sessionId: childSessionId,
    terminalId: `session-${SESSION_ID}`,
  });
  receive({ type: 'terminal_session_runtime', sessionId: childSessionId, running: false });
  assert.equal(useTabStore.getState().tabs.some((tab) => tab.id === tabId), false);

  releaseLoad();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(useTabStore.getState().tabs.some((tab) => tab.id === tabId), false);
});

test('rapid chained rebounds apply only the latest child when loads resolve in reverse', async (t) => {
  const middleSessionId = 'rebound-middle';
  const finalSessionId = 'rebound-final';
  const tabId = 'rebound-chain-tab';
  const panelId = 'rebound-chain-panel';
  let releaseFirst!: () => void;
  let releaseSecond!: () => void;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const secondGate = new Promise<void>((resolve) => { releaseSecond = resolve; });
  const originalLoadProjects = useSessionStore.getState().loadProjects;
  t.after(() => useSessionStore.setState({ loadProjects: originalLoadProjects }));
  let loadCount = 0;
  useSessionStore.setState({
    projects: [project(terminalSession(SESSION_ID, true))],
    loadProjects: async () => {
      loadCount += 1;
      await (loadCount === 1 ? firstGate : secondGate);
      useSessionStore.setState({
        projects: [project(
          terminalSession(SESSION_ID),
          terminalSession(middleSessionId),
          terminalSession(finalSessionId, true),
        )],
      });
    },
  });
  useTabStore.setState({
    tabs: [{ id: tabId, projectDir: '/workspace', title: null, isPreview: false }],
    activeTabId: tabId,
    lruTabIds: [tabId],
  });
  usePanelStore.setState({
    activeTabId: tabId,
    tabPanels: {
      [tabId]: {
        layout: { type: 'leaf', panelId },
        panels: { [panelId]: { id: panelId, sessionId: SESSION_ID } },
        activePanelId: panelId,
      },
    },
  });
  const terminalId = `session-${SESSION_ID}`;

  receive({
    type: 'terminal_session_rebound',
    previousSessionId: SESSION_ID,
    sessionId: middleSessionId,
    terminalId,
  });
  receive({
    type: 'terminal_session_rebound',
    previousSessionId: middleSessionId,
    sessionId: finalSessionId,
    terminalId,
  });
  releaseSecond();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(useTabStore.getState().findSessionLocation(finalSessionId), { tabId, panelId });

  releaseFirst();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(useTabStore.getState().findSessionLocation(finalSessionId), { tabId, panelId });
  assert.equal(useTabStore.getState().findSessionLocation(middleSessionId), null);
});

test('starting the fork parent in another terminal does not cancel the original terminal rebound', async (t) => {
  const childSessionId = 'reopened-parent-child';
  const tabId = 'reopened-parent-tab';
  const panelId = 'reopened-parent-panel';
  let releaseLoad!: () => void;
  const loadGate = new Promise<void>((resolve) => { releaseLoad = resolve; });
  const originalLoadProjects = useSessionStore.getState().loadProjects;
  t.after(() => useSessionStore.setState({ loadProjects: originalLoadProjects }));
  useSessionStore.setState({
    projects: [project(terminalSession(SESSION_ID, true))],
    loadProjects: async () => {
      await loadGate;
      useSessionStore.setState({
        projects: [project(
          terminalSession(SESSION_ID, true),
          terminalSession(childSessionId, true),
        )],
      });
    },
  });
  useTabStore.setState({
    tabs: [{ id: tabId, projectDir: '/workspace', title: null, isPreview: false }],
    activeTabId: tabId,
    lruTabIds: [tabId],
  });
  usePanelStore.setState({
    activeTabId: tabId,
    tabPanels: {
      [tabId]: {
        layout: { type: 'leaf', panelId },
        panels: { [panelId]: { id: panelId, sessionId: SESSION_ID } },
        activePanelId: panelId,
      },
    },
  });

  receive({
    type: 'terminal_session_rebound',
    previousSessionId: SESSION_ID,
    sessionId: childSessionId,
    terminalId: `session-${SESSION_ID}`,
  });
  receive({
    type: 'terminal_session_runtime',
    sessionId: SESSION_ID,
    terminalId: 'separately-reopened-terminal',
    running: true,
  });
  releaseLoad();
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(useTabStore.getState().findSessionLocation(SESSION_ID), null);
  assert.deepEqual(useTabStore.getState().findSessionLocation(childSessionId), { tabId, panelId });
  assert.equal(useSessionStore.getState().getSession(SESSION_ID)?.isRunning, true);
  assert.equal(useSessionStore.getState().getSession(childSessionId)?.isRunning, true);
});

test('reconnect snapshot cancels a stale pending rebound omitted by the server', async (t) => {
  const childSessionId = 'reconnect-reopened-parent-child';
  const tabId = 'reconnect-reopened-parent-tab';
  const panelId = 'reconnect-reopened-parent-panel';
  let releaseLoad!: () => void;
  const loadGate = new Promise<void>((resolve) => { releaseLoad = resolve; });
  const originalLoadProjects = useSessionStore.getState().loadProjects;
  t.after(() => useSessionStore.setState({ loadProjects: originalLoadProjects }));
  useSessionStore.setState({
    projects: [project(terminalSession(SESSION_ID, true))],
    loadProjects: async () => {
      await loadGate;
      useSessionStore.setState({
        projects: [project(
          terminalSession(SESSION_ID, true),
          terminalSession(childSessionId, true),
        )],
      });
    },
  });
  useTabStore.setState({
    tabs: [{ id: tabId, projectDir: '/workspace', title: null, isPreview: false }],
    activeTabId: tabId,
    lruTabIds: [tabId],
  });
  usePanelStore.setState({
    activeTabId: tabId,
    tabPanels: {
      [tabId]: {
        layout: { type: 'leaf', panelId },
        panels: { [panelId]: { id: panelId, sessionId: SESSION_ID } },
        activePanelId: panelId,
      },
    },
  });

  receive({
    type: 'terminal_session_rebound',
    previousSessionId: SESSION_ID,
    sessionId: childSessionId,
    terminalId: `session-${SESSION_ID}`,
  });
  receive({
    type: 'terminal_session_runtime_snapshot',
    activeSessionIds: [SESSION_ID, childSessionId],
    reboundSessions: [],
  });
  releaseLoad();
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.deepEqual(useTabStore.getState().findSessionLocation(SESSION_ID), { tabId, panelId });
  assert.equal(useTabStore.getState().findSessionLocation(childSessionId), null);
});

test('archiving a stopped PTY session retires its open surface after the request succeeds', async (t) => {
  const tabId = 'archived-terminal-tab';
  const panelId = 'archived-terminal-panel';
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  useTabStore.setState({
    tabs: [{ id: tabId, projectDir: '/workspace', title: null, isPreview: false }],
    activeTabId: tabId,
    lruTabIds: [tabId],
  });
  usePanelStore.setState({
    activeTabId: tabId,
    tabPanels: {
      [tabId]: {
        layout: { type: 'leaf', panelId },
        panels: { [panelId]: { id: panelId, sessionId: SESSION_ID } },
        activePanelId: panelId,
      },
    },
  });

  useSessionStore.getState().toggleArchive(SESSION_ID, true);
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(useTabStore.getState().tabs.some((tab) => tab.id === tabId), false);
  assert.equal(useTabStore.getState().findSessionLocation(SESSION_ID), null);
});

test('PTY runtime exit defers surface retirement while archive rollback is still possible', () => {
  const tabId = 'pending-archive-terminal-tab';
  const panelId = 'pending-archive-terminal-panel';
  useSessionStore.setState({
    projects: [project({ ...terminalSession(SESSION_ID, true), archived: true })],
  });
  useTabStore.setState({
    tabs: [{ id: tabId, projectDir: '/workspace', title: null, isPreview: false }],
    activeTabId: tabId,
    lruTabIds: [tabId],
  });
  usePanelStore.setState({
    activeTabId: tabId,
    tabPanels: {
      [tabId]: {
        layout: { type: 'leaf', panelId },
        panels: { [panelId]: { id: panelId, sessionId: SESSION_ID } },
        activePanelId: panelId,
      },
    },
  });

  receive({
    type: 'terminal_session_runtime',
    sessionId: SESSION_ID,
    running: false,
  } as ServerTransportMessage);

  assert.equal(useTabStore.getState().tabs.some((tab) => tab.id === tabId), true);
  assert.deepEqual(useTabStore.getState().findSessionLocation(SESSION_ID), { tabId, panelId });
});

test('archiving a task retires the open surfaces of its PTY sessions', async (t) => {
  const taskId = 'task-with-terminal';
  const tabId = 'task-terminal-tab';
  const panelId = 'task-terminal-panel';
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  useTaskStore.setState({
    tasks: [{
      id: taskId,
      projectId: '/workspace',
      title: 'Task with PTY',
      workflowStatus: 'in_progress',
      sortOrder: 0,
      sessions: [{
        id: SESSION_ID,
        title: 'PTY session',
        provider: 'claude-code',
        lastModified: '2026-07-14T00:00:00.000Z',
        isRunning: false,
        kind: 'terminal',
      }],
      createdAt: '2026-07-14T00:00:00.000Z',
      updatedAt: '2026-07-14T00:00:00.000Z',
    }],
    tasksByProject: {},
    currentProjectId: '/workspace',
  });
  usePanelStore.setState({
    activeTabId: tabId,
    tabPanels: {
      [tabId]: {
        layout: { type: 'leaf', panelId },
        panels: { [panelId]: { id: panelId, sessionId: SESSION_ID } },
        activePanelId: panelId,
      },
    },
  });
  useTabStore.setState({
    tabs: [{ id: tabId, projectDir: '/workspace', title: null, isPreview: false }],
    activeTabId: tabId,
    lruTabIds: [tabId],
  });

  const archived = await useTaskStore.getState().toggleTaskArchive(taskId, true);

  assert.equal(archived, true);
  assert.equal(useTabStore.getState().tabs.some((tab) => tab.id === tabId), false);
  assert.equal(useTabStore.getState().findSessionLocation(SESSION_ID), null);
});

test('PTY runtime exit clears terminal processing when no Stop hook arrives', () => {
  receive({
    type: 'terminal_session_runtime',
    sessionId: SESSION_ID,
    running: true,
  } as ServerTransportMessage);

  receive({
    type: 'session_state',
    sessionId: SESSION_ID,
    terminalId: `session-${SESSION_ID}`,
    status: 'running',
    hookEvent: 'UserPromptSubmit',
  });
  assert.equal(
    useTerminalSessionStore.getState().bySessionId[SESSION_ID]?.status,
    'running',
  );

  receive({
    type: 'terminal_session_runtime',
    sessionId: SESSION_ID,
    running: false,
  } as ServerTransportMessage);

  assert.notEqual(
    useTerminalSessionStore.getState().bySessionId[SESSION_ID]?.status,
    'running',
  );
  assert.equal(isTurnInFlight(useChatStore.getState(), SESSION_ID), false);

  const tabId = 'stale-hook-preview-tab';
  const panelId = 'stale-hook-preview-panel';
  useTabStore.setState({
    tabs: [{ id: tabId, projectDir: '/workspace', title: null, isPreview: true }],
    activeTabId: tabId,
    lruTabIds: [tabId],
  });
  usePanelStore.setState({
    activeTabId: tabId,
    tabPanels: {
      [tabId]: {
        layout: { type: 'leaf', panelId },
        panels: { [panelId]: { id: panelId, sessionId: SESSION_ID } },
        activePanelId: panelId,
      },
    },
  });

  receive({
    type: 'session_state',
    sessionId: SESSION_ID,
    terminalId: `session-${SESSION_ID}`,
    status: 'running',
    hookEvent: 'PostToolUse',
  });
  assert.notEqual(
    useTerminalSessionStore.getState().bySessionId[SESSION_ID]?.status,
    'running',
  );
  assert.equal(isTurnInFlight(useChatStore.getState(), SESSION_ID), false);
  assert.equal(useTabStore.getState().tabs[0]?.isPreview, true);
});

test('a running hook state is kept even while the session list still reads stale isRunning=false', () => {
  // 세션 목록(HTTP)이 낡아 isRunning=false인 동안 hook의 running이 먼저 도착하는
  // 실측 시나리오 — runtime 종료 신호를 받은 적이 없으므로 버려선 안 된다.
  // (버리면 session_state는 재전송이 없어 다음 hook 이벤트까지 스피너가 영영 없다.)
  assert.equal(useSessionStore.getState().getSession(SESSION_ID)?.isRunning, false);

  receive({
    type: 'session_state',
    sessionId: SESSION_ID,
    terminalId: `session-${SESSION_ID}`,
    status: 'running',
    hookEvent: 'UserPromptSubmit',
  });

  assert.equal(
    useTerminalSessionStore.getState().bySessionId[SESSION_ID]?.status,
    'running',
  );
});

test('a runtime restart lifts the ghost-state guard for subsequent hook activity', () => {
  receive({
    type: 'terminal_session_runtime',
    sessionId: SESSION_ID,
    running: true,
  } as ServerTransportMessage);
  receive({
    type: 'session_state',
    sessionId: SESSION_ID,
    terminalId: `session-${SESSION_ID}`,
    status: 'running',
    hookEvent: 'UserPromptSubmit',
  });

  // 런타임 종료 — 이후의 늦은 활동 이벤트는 무시된다.
  receive({
    type: 'terminal_session_runtime',
    sessionId: SESSION_ID,
    running: false,
  } as ServerTransportMessage);
  receive({
    type: 'session_state',
    sessionId: SESSION_ID,
    terminalId: `session-${SESSION_ID}`,
    status: 'running',
    hookEvent: 'PostToolUse',
  });
  assert.notEqual(
    useTerminalSessionStore.getState().bySessionId[SESSION_ID]?.status,
    'running',
  );

  // 런타임 재시작 — 가드가 풀려 다음 턴의 running이 정상 반영된다.
  receive({
    type: 'terminal_session_runtime',
    sessionId: SESSION_ID,
    running: true,
  } as ServerTransportMessage);
  receive({
    type: 'session_state',
    sessionId: SESSION_ID,
    terminalId: `session-${SESSION_ID}`,
    status: 'running',
    hookEvent: 'UserPromptSubmit',
  });
  assert.equal(
    useTerminalSessionStore.getState().bySessionId[SESSION_ID]?.status,
    'running',
  );
});

test('a hook state arriving after the runtime exit signal cannot start a ghost spinner', () => {
  // 앱 재시작 직후 실측 시나리오: 죽은 세션의 runtime-exit 신호가 hook 상태보다
  // 먼저 도착한다. 그 뒤 늦게 배달된 running curl이 store의 첫 엔트리가 되면
  // 다시 꺼줄 신호가 없어 영구 스피너가 된다 — tombstone이 이를 막아야 한다.
  receive({
    type: 'terminal_session_runtime',
    sessionId: SESSION_ID,
    running: false,
  } as ServerTransportMessage);

  receive({
    type: 'session_state',
    sessionId: SESSION_ID,
    terminalId: `session-${SESSION_ID}`,
    status: 'running',
    hookEvent: 'PreToolUse',
  });

  assert.notEqual(
    useTerminalSessionStore.getState().bySessionId[SESSION_ID]?.status,
    'running',
  );
});

test('a runtime snapshot demotes tracked hook states even before the session list loads', () => {
  // 연결 직후에는 projects가 아직 비어 있다 — snapshot 정리가 세션 목록에
  // 의존하면 이미 store에 있는 유령 running을 강등하지 못한다.
  useSessionStore.setState({ projects: [] });
  useTerminalSessionStore.setState({
    bySessionId: {
      [SESSION_ID]: {
        status: 'running',
        hookEvent: 'UserPromptSubmit',
        terminalId: `session-${SESSION_ID}`,
        updatedAt: Date.now(),
      },
    },
  });

  receive({
    type: 'terminal_session_runtime_snapshot',
    activeSessionIds: [],
  } as ServerTransportMessage);

  assert.notEqual(
    useTerminalSessionStore.getState().bySessionId[SESSION_ID]?.status,
    'running',
  );
});

test('PTY AskUserQuestion marks input_required without touching the GUI prompt map', () => {
  receive({
    type: 'terminal_session_runtime',
    sessionId: SESSION_ID,
    running: true,
  } as ServerTransportMessage);
  receive({
    type: 'session_state',
    sessionId: SESSION_ID,
    terminalId: `session-${SESSION_ID}`,
    status: 'running',
    hookEvent: 'UserPromptSubmit',
  });

  receive({
    type: 'session_state',
    sessionId: SESSION_ID,
    terminalId: `session-${SESSION_ID}`,
    status: 'input_required',
    hookEvent: 'PreToolUse',
    preview: '어느 방식으로 할까요?',
  });

  assert.equal(
    useTerminalSessionStore.getState().bySessionId[SESSION_ID]?.status,
    'input_required',
  );
  // GUI 노란점 소스(chat-store activeInteractivePrompt)는 건드리지 않는다.
  assert.equal(useChatStore.getState().activeInteractivePrompt.has(SESSION_ID), false);

  // 답변 제출(PostToolUse) → running 복귀.
  receive({
    type: 'session_state',
    sessionId: SESSION_ID,
    terminalId: `session-${SESSION_ID}`,
    status: 'running',
    hookEvent: 'PostToolUse',
  });
  assert.equal(
    useTerminalSessionStore.getState().bySessionId[SESSION_ID]?.status,
    'running',
  );
});

test('PTY runtime exit clears a lingering input_required state', () => {
  receive({
    type: 'terminal_session_runtime',
    sessionId: SESSION_ID,
    running: true,
  } as ServerTransportMessage);
  receive({
    type: 'session_state',
    sessionId: SESSION_ID,
    terminalId: `session-${SESSION_ID}`,
    status: 'input_required',
    hookEvent: 'PreToolUse',
  });

  receive({
    type: 'terminal_session_runtime',
    sessionId: SESSION_ID,
    running: false,
  } as ServerTransportMessage);

  // 죽은 런타임의 질문에는 답할 수 없다 — 노란 점이 영영 깜빡이면 안 된다.
  assert.notEqual(
    useTerminalSessionStore.getState().bySessionId[SESSION_ID]?.status,
    'input_required',
  );
});

test('GUI session-list reconciliation cannot clear PTY input_required state', () => {
  receive({
    type: 'terminal_session_runtime',
    sessionId: SESSION_ID,
    running: true,
  } as ServerTransportMessage);
  receive({
    type: 'session_state',
    sessionId: SESSION_ID,
    terminalId: `session-${SESSION_ID}`,
    status: 'input_required',
    hookEvent: 'PreToolUse',
  });

  receive({
    type: 'session_list',
    sessions: [{
      id: SESSION_ID,
      status: 'running',
      isGenerating: false,
      createdAt: '2026-07-14T00:00:00.000Z',
      activeInteractivePrompt: null,
      todoSnapshot: [],
    }],
    titleGeneratingSessionIds: [],
  });

  assert.equal(
    useTerminalSessionStore.getState().bySessionId[SESSION_ID]?.status,
    'input_required',
  );
});

test('new PTY sessions are stopped until their terminal is opened', () => {
  useSessionStore.setState({ projects: [] });

  receive({
    type: 'session_created',
    sessionId: 'new-terminal-session',
    status: 'ready',
    workDir: '/workspace',
    kind: 'terminal',
    provider: 'claude-code',
  });

  const created = useSessionStore.getState().getSession('new-terminal-session');
  assert.equal(created?.isRunning, false);
  assert.equal(created?.status, 'stopped');
});

test('PTY runtime snapshot reconciles sessions after a WebSocket reconnect', () => {
  const inactiveSessionId = 'terminal-session-inactive';
  useSessionStore.setState({
    projects: [project(
      terminalSession(SESSION_ID, false),
      terminalSession(inactiveSessionId, true),
    )],
  });
  useTerminalSessionStore.setState({
    bySessionId: {
      [SESSION_ID]: {
        status: 'running',
        hookEvent: 'UserPromptSubmit',
        terminalId: `session-${SESSION_ID}`,
        updatedAt: Date.now(),
      },
      [inactiveSessionId]: {
        status: 'running',
        hookEvent: 'UserPromptSubmit',
        terminalId: `session-${inactiveSessionId}`,
        updatedAt: Date.now(),
      },
    },
  });
  useChatStore.setState({
    turnInFlightBySession: {},
  });

  receive({
    type: 'terminal_session_runtime_snapshot',
    activeSessionIds: [SESSION_ID],
  } as ServerTransportMessage);

  assert.equal(useSessionStore.getState().getSession(SESSION_ID)?.isRunning, true);
  assert.equal(isTurnInFlight(useChatStore.getState(), SESSION_ID), false);
  assert.equal(
    useTerminalSessionStore.getState().bySessionId[SESSION_ID]?.status,
    'running',
  );
  const inactive = useSessionStore.getState().getSession(inactiveSessionId);
  assert.equal(inactive?.isRunning, false);
  assert.equal(inactive?.status, 'stopped');
  assert.notEqual(
    useTerminalSessionStore.getState().bySessionId[inactiveSessionId]?.status,
    'running',
  );
  assert.equal(isTurnInFlight(useChatStore.getState(), inactiveSessionId), false);
});

test('PTY runtime snapshot received before project loading keeps the menu running state', async (t) => {
  useSessionStore.setState({ projects: [] });

  let resolveFetch!: (response: Response) => void;
  t.mock.method(globalThis, 'fetch', () => new Promise<Response>((resolve) => {
    resolveFetch = resolve;
  }));

  const loading = useSessionStore.getState().loadProjects();

  receive({
    type: 'terminal_session_runtime_snapshot',
    activeSessionIds: [SESSION_ID],
  } as ServerTransportMessage);

  resolveFetch(new Response(JSON.stringify({
    projects: [project(terminalSession(SESSION_ID, false))],
  }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  }));
  await loading;

  assert.equal(useSessionStore.getState().getSession(SESSION_ID)?.isRunning, true);
});

test('GUI runtime start received during project loading keeps the menu running state', async (t) => {
  const guiSessionId = 'gui-session-a';
  const staleSession = guiSession(guiSessionId, false);
  useSessionStore.setState({ projects: [project(staleSession)] });

  let resolveFetch!: (response: Response) => void;
  t.mock.method(globalThis, 'fetch', () => new Promise<Response>((resolve) => {
    resolveFetch = resolve;
  }));

  const loading = useSessionStore.getState().loadProjects();

  receive({
    type: 'session_started',
    sessionId: guiSessionId,
    workDir: '/workspace',
  });

  resolveFetch(new Response(JSON.stringify({
    projects: [project(staleSession)],
  }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  }));
  await loading;

  assert.equal(useSessionStore.getState().getSession(guiSessionId)?.isRunning, true);
});

test('GUI runtime snapshot clears stale menu running state after reconnect', () => {
  const guiSessionId = 'gui-session-a';
  useSessionStore.setState({ projects: [project(guiSession(guiSessionId, true))] });
  useSessionStore.getState().markSessionRunning(guiSessionId, guiSessionId);
  useSessionStore.getState().beginRuntimeConnection();

  receive({
    type: 'session_list',
    sessions: [],
    titleGeneratingSessionIds: [],
  });

  assert.equal(useSessionStore.getState().getSession(guiSessionId)?.isRunning, false);
});

test('GUI runtime event received during reconnect outranks the initial snapshot', () => {
  const guiSessionId = 'gui-session-a';
  useSessionStore.setState({ projects: [project(guiSession(guiSessionId, false))] });
  useSessionStore.getState().beginRuntimeConnection();

  receive({
    type: 'session_started',
    sessionId: guiSessionId,
    workDir: '/workspace',
  });
  receive({
    type: 'session_list',
    sessions: [],
    titleGeneratingSessionIds: [],
  });

  assert.equal(useSessionStore.getState().getSession(guiSessionId)?.isRunning, true);
});
