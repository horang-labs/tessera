import assert from 'node:assert/strict';
import test, { beforeEach } from 'node:test';
import { handleIncomingServerMessage } from '@/lib/ws/client-message-handlers';
import type { ServerTransportMessage } from '@/lib/ws/message-types';
import { isTurnInFlight, useChatStore } from '@/stores/chat-store';
import { useSessionStore } from '@/stores/session-store';
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
  useSessionStore.setState({
    projects: [project(terminalSession())],
    activeSessionId: null,
    runningWorkflowSessionIds: new Set(),
  });
});

test('PTY UserPromptSubmit marks the session as processing without changing runtime liveness', () => {
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

  assert.equal(isTurnInFlight(useChatStore.getState(), SESSION_ID), true);
  assert.equal(useSessionStore.getState().getSession(SESSION_ID)?.isRunning, true);
});

test('PTY runtime state owns the session Running indicator across completed turns', () => {
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
  assert.equal(isTurnInFlight(useChatStore.getState(), SESSION_ID), true);

  receive({
    type: 'session_state',
    sessionId: SESSION_ID,
    terminalId: `session-${SESSION_ID}`,
    status: 'completed',
    hookEvent: 'Stop',
  });
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

test('PTY runtime exit clears processing when no Stop hook arrives', () => {
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
  assert.equal(isTurnInFlight(useChatStore.getState(), SESSION_ID), true);

  receive({
    type: 'terminal_session_runtime',
    sessionId: SESSION_ID,
    running: false,
  } as ServerTransportMessage);

  assert.equal(isTurnInFlight(useChatStore.getState(), SESSION_ID), false);

  receive({
    type: 'session_state',
    sessionId: SESSION_ID,
    terminalId: `session-${SESSION_ID}`,
    status: 'running',
    hookEvent: 'PostToolUse',
  });
  assert.equal(isTurnInFlight(useChatStore.getState(), SESSION_ID), false);
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
  useChatStore.setState({
    turnInFlightBySession: {
      [SESSION_ID]: true,
      [inactiveSessionId]: true,
    },
  });

  receive({
    type: 'terminal_session_runtime_snapshot',
    activeSessionIds: [SESSION_ID],
  } as ServerTransportMessage);

  assert.equal(useSessionStore.getState().getSession(SESSION_ID)?.isRunning, true);
  assert.equal(isTurnInFlight(useChatStore.getState(), SESSION_ID), true);
  const inactive = useSessionStore.getState().getSession(inactiveSessionId);
  assert.equal(inactive?.isRunning, false);
  assert.equal(inactive?.status, 'stopped');
  assert.equal(isTurnInFlight(useChatStore.getState(), inactiveSessionId), false);
});
