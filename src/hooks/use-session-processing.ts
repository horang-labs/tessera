'use client';

import { useCallback } from 'react';
import { isTurnInFlight, selectIsTurnInFlight, useChatStore } from '@/stores/chat-store';
import {
  isTerminalTurnProcessing,
  selectIsTerminalTurnProcessing,
  useTerminalSessionStore,
} from '@/stores/terminal-session-store';
import { selectHasRunningWorkflow, useSessionStore } from '@/stores/session-store';
import { useProjectViewSession } from '@/hooks/use-project-view-workspace-state';
import {
  resolveIsTerminalSession,
  useSessionKindGroups,
  type SessionKindTarget,
} from './use-session-kind-groups';
import type { UnifiedSession } from '@/types/chat';

export { resolveIsTerminalSession } from './use-session-kind-groups';

interface SessionProcessingSources {
  isTerminal: boolean;
  guiTurnInFlight: boolean;
  guiWorkflowRunning: boolean;
  terminalTurnProcessing: boolean;
}

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

/**
 * Resolve the visible processing signal without mixing GUI and PTY lifecycles.
 * GUI keeps its existing chat turn/workflow sources. PTY reads only hook state.
 */
export function useIsSessionProcessing(
  sessionId: string,
  fallbackKind?: UnifiedSession['kind'],
): boolean {
  const session = useProjectViewSession(sessionId);
  const isTerminal = resolveIsTerminalSession(session?.kind, fallbackKind);
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
  sessions: readonly SessionKindTarget[],
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
  sessions: readonly SessionKindTarget[],
): SessionProcessingSummary {
  const { guiIds, terminalIds } = useSessionKindGroups(sessions);
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
