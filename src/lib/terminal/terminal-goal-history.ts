import { getDb } from '@/lib/db/database';
import * as dbSessions from '@/lib/db/sessions';
import logger from '@/lib/logger';
import {
  dismissTerminalGoalInHistory,
  latestEndedTerminalGoal,
  mergeTerminalGoalHistory,
  parseTerminalGoalHistory,
  type TerminalGoalHistoryEntry,
  type TerminalGoalProvider,
} from '@/types/terminal-goal';

/**
 * Ended `/goal`s of a PTY session, kept under `provider_state.goalHistory`.
 *
 * The live goal is rebuilt from the transcript, but the tracker only replays
 * its tail and hides goals that already ended, so this is the only durable
 * record of what the session was steered toward.
 */

const HISTORY_KEY = 'goalHistory';

function parseProviderState(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

export function readTerminalGoalHistory(sessionId: string): TerminalGoalHistoryEntry[] {
  const row = dbSessions.getSession(sessionId);
  if (!row || row.deleted === 1) return [];
  return parseTerminalGoalHistory(parseProviderState(row.provider_state)[HISTORY_KEY]);
}

/**
 * Adds ended goals to the session's history. Returns the new history, or null
 * when nothing changed (every entry was already recorded, or too old to keep).
 */
export function appendTerminalGoalHistory(
  sessionId: string,
  entries: readonly TerminalGoalHistoryEntry[],
): TerminalGoalHistoryEntry[] | null {
  if (!entries.length) return null;
  try {
    const row = dbSessions.getSession(sessionId);
    if (!row || row.deleted === 1) return null;
    const state = parseProviderState(row.provider_state);
    const merged = mergeTerminalGoalHistory(parseTerminalGoalHistory(state[HISTORY_KEY]), entries);
    if (!merged) return null;
    // A goal ending is not session activity: keep the sidebar order.
    dbSessions.updateSession(
      sessionId,
      { provider_state: JSON.stringify({ ...state, [HISTORY_KEY]: merged }) },
      { skipTimestamp: true },
    );
    return merged;
  } catch (error) {
    logger.warn({ sessionId, error: (error as Error).message }, 'Terminal goal history write failed');
    return null;
  }
}

/**
 * Records that the user closed an ended goal's banner, so every window (and
 * the next launch) stops marking the session with it. Returns the new
 * history, or null when nothing changed.
 */
export function dismissTerminalGoal(
  sessionId: string,
  provider: TerminalGoalProvider,
  setAt: number,
): TerminalGoalHistoryEntry[] | null {
  try {
    const row = dbSessions.getSession(sessionId);
    if (!row || row.deleted === 1) return null;
    const state = parseProviderState(row.provider_state);
    const next = dismissTerminalGoalInHistory(
      parseTerminalGoalHistory(state[HISTORY_KEY]),
      provider,
      setAt,
      Date.now(),
    );
    if (!next) return null;
    dbSessions.updateSession(
      sessionId,
      { provider_state: JSON.stringify({ ...state, [HISTORY_KEY]: next }) },
      { skipTimestamp: true },
    );
    return next;
  } catch (error) {
    logger.warn({ sessionId, error: (error as Error).message }, 'Terminal goal dismiss failed');
    return null;
  }
}

/**
 * Every session still marked by a goal it finished, for a new connection.
 * One query; only rows that ever recorded a goal are parsed.
 */
export function readEndedTerminalGoals(): Record<string, TerminalGoalHistoryEntry> {
  const result: Record<string, TerminalGoalHistoryEntry> = {};
  try {
    const rows = getDb().prepare(
      `SELECT id, provider_state FROM sessions WHERE deleted = 0 AND provider_state LIKE '%"${HISTORY_KEY}"%'`,
    ).all() as Array<{ id: string; provider_state: string | null }>;
    for (const row of rows) {
      const ended = latestEndedTerminalGoal(
        parseTerminalGoalHistory(parseProviderState(row.provider_state)[HISTORY_KEY]),
      );
      if (ended) result[row.id] = ended;
    }
  } catch (error) {
    logger.warn({ error: (error as Error).message }, 'Terminal ended goals read failed');
  }
  return result;
}
