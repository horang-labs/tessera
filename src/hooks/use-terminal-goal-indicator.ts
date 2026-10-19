'use client';

import { useCallback } from 'react';
import {
  selectTerminalGoalIndicator,
  useTerminalGoalStore,
  type TerminalGoalIndicator,
} from '@/stores/terminal-goal-store';

/** Goal state for one session's status dot. */
export function useTerminalGoalIndicator(sessionId: string): TerminalGoalIndicator {
  return useTerminalGoalStore(selectTerminalGoalIndicator(sessionId));
}

/** Goal state for a dot standing for several sessions (a tab): active wins. */
export function useAnyTerminalGoalIndicator(sessionIds: readonly string[]): TerminalGoalIndicator {
  return useTerminalGoalStore(useCallback((state) => {
    let indicator: TerminalGoalIndicator = null;
    for (const sessionId of sessionIds) {
      const next = selectTerminalGoalIndicator(sessionId)(state);
      if (next === 'active') return 'active';
      if (next) indicator = next;
    }
    return indicator;
  }, [sessionIds]));
}
