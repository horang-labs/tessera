import { create } from 'zustand';
import type { TerminalGoalSnapshot } from '@/types/terminal-goal';

/**
 * `/goal` state of PTY sessions, pushed by the server's transcript tracker.
 * Separate from terminal-session-store: the goal outlives individual turns,
 * and the hook state machine there must not learn about it.
 */
interface TerminalGoalStore {
  bySessionId: Record<string, TerminalGoalSnapshot>;
  /** Ended goals the user closed, keyed by session → the goal's `setAt`. */
  dismissedSetAt: Record<string, number>;
  applyGoal: (sessionId: string, goal: TerminalGoalSnapshot | null) => void;
  dismiss: (sessionId: string, setAt: number) => void;
  clearSession: (sessionId: string) => void;
}

export const useTerminalGoalStore = create<TerminalGoalStore>((set) => ({
  bySessionId: {},
  dismissedSetAt: {},
  applyGoal: (sessionId, goal) => set((prev) => {
    if (!goal) {
      if (!(sessionId in prev.bySessionId)) return prev;
      const next = { ...prev.bySessionId };
      delete next[sessionId];
      return { bySessionId: next };
    }
    return { bySessionId: { ...prev.bySessionId, [sessionId]: goal } };
  }),
  dismiss: (sessionId, setAt) => set((prev) => ({
    dismissedSetAt: { ...prev.dismissedSetAt, [sessionId]: setAt },
  })),
  clearSession: (sessionId) => set((prev) => {
    if (!(sessionId in prev.bySessionId)) return prev;
    const next = { ...prev.bySessionId };
    delete next[sessionId];
    return { bySessionId: next };
  }),
}));

export type TerminalGoalIndicator = 'active' | 'paused' | null;

/** What the session status dot should say about the goal. */
export const selectTerminalGoalIndicator = (sessionId: string) =>
  (state: TerminalGoalStore): TerminalGoalIndicator => {
    const status = state.bySessionId[sessionId]?.status;
    if (status === 'active') return 'active';
    if (status === 'paused') return 'paused';
    return null;
  };

/** The goal the banner shows, or null once the user dismissed an ended one. */
export const selectVisibleTerminalGoal = (sessionId: string) =>
  (state: TerminalGoalStore): TerminalGoalSnapshot | null => {
    const goal = state.bySessionId[sessionId];
    if (!goal) return null;
    const ended = goal.status !== 'active' && goal.status !== 'paused';
    if (ended && state.dismissedSetAt[sessionId] === goal.setAt) return null;
    return goal;
  };
