'use client';

import { useEffect } from 'react';
import { useTerminalGoalStore } from '@/stores/terminal-goal-store';
import { parseTerminalGoalHistory, type TerminalGoalHistoryEntry } from '@/types/terminal-goal';

const EMPTY_HISTORY: TerminalGoalHistoryEntry[] = [];
const inFlight = new Map<string, Promise<void>>();

function loadHistory(sessionId: string): Promise<void> {
  const pending = inFlight.get(sessionId);
  if (pending) return pending;
  const request = (async () => {
    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/goal-history`);
      if (!response.ok) return;
      const body = await response.json() as { history?: unknown };
      // A push that landed meanwhile is at least as new as this response.
      if (useTerminalGoalStore.getState().historyBySessionId[sessionId]) return;
      useTerminalGoalStore.getState().setHistory(sessionId, parseTerminalGoalHistory(body.history));
    } catch {
      // Offline or the session is gone; the history simply stays hidden.
    } finally {
      inFlight.delete(sessionId);
    }
  })();
  inFlight.set(sessionId, request);
  return request;
}

/**
 * Ended goals of a PTY session, newest first. Loaded once over HTTP, then kept
 * current by `terminal_goal_history` pushes.
 */
export function useTerminalGoalHistory(
  sessionId: string,
  enabled = true,
): TerminalGoalHistoryEntry[] {
  const history = useTerminalGoalStore((state) => state.historyBySessionId[sessionId]);
  const loaded = history !== undefined;
  useEffect(() => {
    if (enabled && !loaded) void loadHistory(sessionId);
  }, [enabled, loaded, sessionId]);
  return history ?? EMPTY_HISTORY;
}
