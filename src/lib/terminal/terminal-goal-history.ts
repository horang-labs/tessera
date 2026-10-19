import * as dbSessions from '@/lib/db/sessions';
import logger from '@/lib/logger';
import {
  mergeTerminalGoalHistory,
  parseTerminalGoalHistory,
  type TerminalGoalHistoryEntry,
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
