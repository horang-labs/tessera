import { create } from 'zustand';
import {
  latestEndedTerminalGoal,
  terminalGoalSnapshotFromHistory,
  type TerminalGoalHistoryEntry,
  type TerminalGoalSnapshot,
} from '@/types/terminal-goal';

/**
 * `/goal` state of PTY sessions, pushed by the server's transcript tracker.
 * Separate from terminal-session-store: the goal outlives individual turns,
 * and the hook state machine there must not learn about it.
 *
 * Two sources meet here. The tracker reports the goal it reads from the
 * transcript, but only while it watches a live CLI, and it drops goals that
 * ended before it looked. A goal the session finished is therefore taken from
 * the persisted history as well, so the session keeps saying "achieved" after
 * a restart, a reload, or the CLI exiting — until the user closes it or sets
 * another goal.
 */
interface TerminalGoalStore {
  bySessionId: Record<string, TerminalGoalSnapshot>;
  /** Ended goals the user closed in this window, keyed by session → `setAt`. */
  dismissedSetAt: Record<string, number>;
  /**
   * Ended goals per session, once loaded or pushed. Kept when the runtime
   * stops: the history is about the session, not the running CLI.
   */
  historyBySessionId: Record<string, TerminalGoalHistoryEntry[]>;
  /** The finished goal still marking each session (server snapshot + pushes). */
  endedBySessionId: Record<string, TerminalGoalHistoryEntry>;
  applyGoal: (sessionId: string, goal: TerminalGoalSnapshot | null) => void;
  /** Closes an ended goal's banner and mark, here and (via the server) everywhere. */
  dismiss: (sessionId: string, goal: Pick<TerminalGoalSnapshot, 'provider' | 'setAt'>) => void;
  clearSession: (sessionId: string) => void;
  setHistory: (sessionId: string, history: TerminalGoalHistoryEntry[]) => void;
  setEndedSnapshot: (goals: Record<string, TerminalGoalHistoryEntry>) => void;
}

function withEnded(
  ended: Record<string, TerminalGoalHistoryEntry>,
  sessionId: string,
  entry: TerminalGoalHistoryEntry | null,
): Record<string, TerminalGoalHistoryEntry> {
  if (!entry) {
    if (!(sessionId in ended)) return ended;
    const next = { ...ended };
    delete next[sessionId];
    return next;
  }
  return ended[sessionId] === entry ? ended : { ...ended, [sessionId]: entry };
}

export const useTerminalGoalStore = create<TerminalGoalStore>((set) => ({
  bySessionId: {},
  dismissedSetAt: {},
  historyBySessionId: {},
  endedBySessionId: {},
  applyGoal: (sessionId, goal) => set((prev) => {
    if (!goal) {
      if (!(sessionId in prev.bySessionId)) return prev;
      const next = { ...prev.bySessionId };
      delete next[sessionId];
      return { bySessionId: next };
    }
    return { bySessionId: { ...prev.bySessionId, [sessionId]: goal } };
  }),
  dismiss: (sessionId, goal) => {
    set((prev) => ({ dismissedSetAt: { ...prev.dismissedSetAt, [sessionId]: goal.setAt } }));
    void fetch(`/api/sessions/${encodeURIComponent(sessionId)}/goal-history`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dismiss: { provider: goal.provider, setAt: goal.setAt } }),
    }).catch(() => {
      // Offline: closed in this window; the next connection may show it again.
    });
  },
  clearSession: (sessionId) => set((prev) => {
    if (!(sessionId in prev.bySessionId)) return prev;
    const next = { ...prev.bySessionId };
    delete next[sessionId];
    return { bySessionId: next };
  }),
  setHistory: (sessionId, history) => set((prev) => {
    // Closed in another window: the tracker may still hold the achieved goal.
    const latest = history[0];
    const dismissedSetAt = latest?.dismissedAt !== undefined && prev.dismissedSetAt[sessionId] !== latest.setAt
      ? { ...prev.dismissedSetAt, [sessionId]: latest.setAt }
      : prev.dismissedSetAt;
    return {
      historyBySessionId: { ...prev.historyBySessionId, [sessionId]: history },
      endedBySessionId: withEnded(prev.endedBySessionId, sessionId, latestEndedTerminalGoal(history)),
      dismissedSetAt,
    };
  }),
  setEndedSnapshot: (goals) => set({ endedBySessionId: goals }),
}));

function isEndedStatus(goal: TerminalGoalSnapshot): boolean {
  return goal.status === 'complete' || goal.status === 'failed';
}

// One banner snapshot per history entry, so selectors return a stable object.
const snapshotByEntry = new WeakMap<TerminalGoalHistoryEntry, TerminalGoalSnapshot>();

function snapshotOf(entry: TerminalGoalHistoryEntry): TerminalGoalSnapshot {
  let snapshot = snapshotByEntry.get(entry);
  if (!snapshot) {
    snapshot = terminalGoalSnapshotFromHistory(entry);
    snapshotByEntry.set(entry, snapshot);
  }
  return snapshot;
}

/**
 * The goal the session shows: a live one from the tracker, else the goal it
 * finished, unless the user closed it.
 */
function visibleGoal(state: TerminalGoalStore, sessionId: string): TerminalGoalSnapshot | null {
  const live = state.bySessionId[sessionId];
  if (live && !isEndedStatus(live)) return live;
  const ended = live ?? (state.endedBySessionId[sessionId]
    ? snapshotOf(state.endedBySessionId[sessionId])
    : null);
  if (!ended || state.dismissedSetAt[sessionId] === ended.setAt) return null;
  return ended;
}

export type TerminalGoalIndicator = 'active' | 'paused' | 'achieved' | 'failed' | null;

/** What the session status dot should say about the goal. */
export const selectTerminalGoalIndicator = (sessionId: string) =>
  (state: TerminalGoalStore): TerminalGoalIndicator => {
    switch (visibleGoal(state, sessionId)?.status) {
      case 'active':
        return 'active';
      case 'paused':
      case 'stalled':
        return 'paused';
      case 'complete':
        return 'achieved';
      case 'failed':
        return 'failed';
      default:
        return null;
    }
  };

/** The goal the banner shows, or null once the user dismissed an ended one. */
export const selectVisibleTerminalGoal = (sessionId: string) =>
  (state: TerminalGoalStore): TerminalGoalSnapshot | null => visibleGoal(state, sessionId);
