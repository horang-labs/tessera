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
