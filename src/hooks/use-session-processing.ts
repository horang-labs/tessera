'use client';

import { useCallback, useMemo } from 'react';
import { isTurnInFlight, selectIsTurnInFlight, useChatStore } from '@/stores/chat-store';
import {
  isTerminalTurnProcessing,
  selectIsTerminalTurnProcessing,
  useTerminalSessionStore,
} from '@/stores/terminal-session-store';
import { selectHasRunningWorkflow, useSessionStore } from '@/stores/session-store';
import type { UnifiedSession } from '@/types/chat';

interface SessionProcessingSources {
  isTerminal: boolean;
  guiTurnInFlight: boolean;
  guiWorkflowRunning: boolean;
  terminalTurnProcessing: boolean;
}

type SessionProcessingTarget = string | Pick<UnifiedSession, 'id' | 'kind'>;

export function resolveSessionProcessing({
  isTerminal,
  guiTurnInFlight,
  guiWorkflowRunning,
  terminalTurnProcessing,
}: SessionProcessingSources): boolean {
  return isTerminal
    ? terminalTurnProcessing
    : guiTurnInFlight || guiWorkflowRunning;
}

export function resolveIsTerminalSession(
  storedKind: UnifiedSession['kind'],
  fallbackKind?: UnifiedSession['kind'],
): boolean {
  return (storedKind ?? fallbackKind) === 'terminal';
}

/**
 * Resolve the visible processing signal without mixing GUI and PTY lifecycles.
 * GUI keeps its existing chat turn/workflow sources. PTY reads only hook state.
 */
export function useIsSessionProcessing(
  sessionId: string,
  fallbackKind?: UnifiedSession['kind'],
): boolean {
  const isTerminal = useSessionStore(
    (state) => resolveIsTerminalSession(
      state.getSession(sessionId)?.kind,
      fallbackKind,
    ),
  );
  const guiTurnInFlight = useChatStore(selectIsTurnInFlight(sessionId));
  const guiWorkflowRunning = useSessionStore(selectHasRunningWorkflow(sessionId));
  const terminalTurnProcessing = useTerminalSessionStore(
    selectIsTerminalTurnProcessing(sessionId),
  );

  return resolveSessionProcessing({
    isTerminal,
    guiTurnInFlight,
    guiWorkflowRunning,
    terminalTurnProcessing,
  });
}

export function useAnySessionProcessing(
  sessions: readonly SessionProcessingTarget[],
): boolean {
  return useSessionProcessingSummary(sessions).hasProcessingSession;
}

interface SessionProcessingSummary {
  hasProcessingSession: boolean;
  hasTerminalProcessingSession: boolean;
}

/**
 * Aggregate mixed GUI/PTY session processing while preserving the PTY-only
 * signal needed by status-priority policies.
 */
export function useSessionProcessingSummary(
  sessions: readonly SessionProcessingTarget[],
): SessionProcessingSummary {
  const targetsKey = JSON.stringify(
    sessions
      .map((session) => typeof session === 'string'
        ? { id: session, kind: undefined }
        : { id: session.id, kind: session.kind })
      .sort((left, right) => left.id.localeCompare(right.id)),
  );
  const targets = useMemo(
    () => JSON.parse(targetsKey) as Array<{ id: string; kind?: UnifiedSession['kind'] }>,
    [targetsKey],
  );
  const ids = useMemo(() => targets.map((target) => target.id), [targets]);
  const fallbackKinds = useMemo(
    () => new Map(targets.map((target) => [target.id, target.kind])),
    [targets],
  );

  const terminalIdsKey = useSessionStore(useCallback(
    (state) => ids
      .filter((sessionId) => resolveIsTerminalSession(
        state.getSession(sessionId)?.kind,
        fallbackKinds.get(sessionId),
      ))
      .join(','),
    [fallbackKinds, ids],
  ));
  const terminalIds = useMemo(
    () => terminalIdsKey ? terminalIdsKey.split(',') : [],
    [terminalIdsKey],
  );
  const terminalIdSet = useMemo(() => new Set(terminalIds), [terminalIds]);
  const guiIds = useMemo(
    () => ids.filter((sessionId) => !terminalIdSet.has(sessionId)),
    [ids, terminalIdSet],
  );
  const hasGuiTurnInFlight = useChatStore(useCallback(
    (state) => guiIds.some((sessionId) => isTurnInFlight(state, sessionId)),
    [guiIds],
  ));
  const hasGuiWorkflowRunning = useSessionStore(useCallback(
    (state) => guiIds.some((sessionId) => state.runningWorkflowSessionIds.has(sessionId)),
    [guiIds],
  ));
  const hasTerminalTurnProcessing = useTerminalSessionStore(useCallback(
    (state) => terminalIds.some((sessionId) => isTerminalTurnProcessing(state, sessionId)),
    [terminalIds],
  ));

  return {
    hasProcessingSession:
      hasTerminalTurnProcessing || hasGuiTurnInFlight || hasGuiWorkflowRunning,
    hasTerminalProcessingSession: hasTerminalTurnProcessing,
  };
}
