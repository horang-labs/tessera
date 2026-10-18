/**
 * The `/goal` a PTY (terminal) session is pursuing, as decoded from the
 * provider's own transcript.
 *
 * Claude Code and Codex both implement `/goal` inside the TUI, so Tessera never
 * sees it go through its own protocol. Each CLI records the goal lifecycle in
 * the transcript it already writes, and the server tails that file:
 *
 * - Claude Code: `attachment` lines of type `goal_status` (set / evaluated /
 *   achieved / impossible / cleared).
 * - Codex: `thread_goal_updated` events, `update_goal` tool results, and the
 *   `User cleared the goal.` internal context message.
 */

export type TerminalGoalProvider = 'claude-code' | 'codex';

/**
 * `active`, `paused` and `stalled` are live goals. `stalled` is Codex's own
 * "Goal stalled": the goal is still active but its turn ended in an error or
 * an interrupt, so the CLI waits for `/goal resume`. `blocked`, `usage_limited`
 * and `budget_limited` are Codex's own stop reasons. `complete` and `failed`
 * are terminal; Claude reports `failed` when its evaluator judges the
 * condition impossible.
 */
export type TerminalGoalStatus =
  | 'active'
  | 'paused'
  | 'stalled'
  | 'blocked'
  | 'usage_limited'
  | 'budget_limited'
  | 'complete'
  | 'failed';

export interface TerminalGoalSnapshot {
  provider: TerminalGoalProvider;
  objective: string;
  status: TerminalGoalStatus;
  /** Epoch ms the goal was set. Stable for one goal, so it doubles as its identity. */
  setAt: number;
  /** Epoch ms of the last transcript record that changed this goal. */
  updatedAt: number;
  /** Claude: how many times the evaluator has judged the condition so far. */
  iterations?: number;
  /** Claude: the evaluator's most recent explanation. */
  lastReason?: string;
  /** Total time spent on the goal, when the CLI reports it (Codex live, Claude at the end). */
  elapsedSeconds?: number;
  tokensUsed?: number;
  tokenBudget?: number;
}

const LIVE_STATUSES: ReadonlySet<TerminalGoalStatus> = new Set(['active', 'paused', 'stalled']);

/** Whether the goal still steers the session (as opposed to having ended). */
export function isLiveTerminalGoal(goal: TerminalGoalSnapshot | null | undefined): boolean {
  return !!goal && LIVE_STATUSES.has(goal.status);
}

/** Whether the CLI will keep working on the goal by itself. */
export function isActiveTerminalGoal(goal: TerminalGoalSnapshot | null | undefined): boolean {
  return goal?.status === 'active';
}

export function sameTerminalGoal(
  a: TerminalGoalSnapshot | null | undefined,
  b: TerminalGoalSnapshot | null | undefined,
): boolean {
  if (!a || !b) return !a && !b;
  return a.provider === b.provider
    && a.objective === b.objective
    && a.status === b.status
    && a.setAt === b.setAt
    && a.updatedAt === b.updatedAt
    && a.iterations === b.iterations
    && a.lastReason === b.lastReason
    && a.elapsedSeconds === b.elapsedSeconds
    && a.tokensUsed === b.tokensUsed
    && a.tokenBudget === b.tokenBudget;
}

/** How a goal left the session, as recorded in its history. */
export type TerminalGoalEnding = 'complete' | 'failed' | 'cleared' | 'replaced';

/**
 * A goal the session pursued earlier, kept in `sessions.provider_state` so a
 * handoff or review can see what the session was steered toward. Only ended
 * goals are recorded; the live one is the snapshot above.
 */
export interface TerminalGoalHistoryEntry {
  provider: TerminalGoalProvider;
  objective: string;
  ending: TerminalGoalEnding;
  setAt: number;
  endedAt: number;
  iterations?: number;
  lastReason?: string;
  elapsedSeconds?: number;
  tokensUsed?: number;
  tokenBudget?: number;
}

export const TERMINAL_GOAL_HISTORY_LIMIT = 10;
/** provider_state is parsed on every session listing; keep entries small. */
const HISTORY_OBJECTIVE_MAX_CHARS = 1_000;
const HISTORY_REASON_MAX_CHARS = 300;

function isEndedStatus(status: TerminalGoalStatus): boolean {
  return status === 'complete' || status === 'failed';
}

/**
 * Whether the transition `previous` → `next` ended `previous`, and how.
 * A goal that already reached `complete` or `failed` was recorded then, so a
 * later clear or new goal does not record it again.
 */
export function terminalGoalEnding(
  previous: TerminalGoalSnapshot | null,
  next: TerminalGoalSnapshot | null,
): TerminalGoalEnding | null {
  if (!previous || isEndedStatus(previous.status)) return null;
  if (!next) return 'cleared';
  if (next.objective !== previous.objective || next.setAt !== previous.setAt) return 'replaced';
  if (isEndedStatus(next.status)) return next.status as TerminalGoalEnding;
  return null;
}

function clip(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/** The history record for a goal that ended as `ending`. */
export function buildTerminalGoalHistoryEntry(
  previous: TerminalGoalSnapshot,
  next: TerminalGoalSnapshot | null,
  ending: TerminalGoalEnding,
  endedAt: number,
): TerminalGoalHistoryEntry {
  // A goal that completed carries its final totals; one that was cleared or
  // replaced keeps what it had reached.
  const source = ending === 'complete' || ending === 'failed' ? next ?? previous : previous;
  const entry: TerminalGoalHistoryEntry = {
    provider: previous.provider,
    objective: clip(previous.objective, HISTORY_OBJECTIVE_MAX_CHARS),
    ending,
    setAt: previous.setAt,
    endedAt,
  };
  if (source.iterations !== undefined) entry.iterations = source.iterations;
  if (source.lastReason) entry.lastReason = clip(source.lastReason, HISTORY_REASON_MAX_CHARS);
  if (source.elapsedSeconds !== undefined) entry.elapsedSeconds = source.elapsedSeconds;
  if (source.tokensUsed !== undefined) entry.tokensUsed = source.tokensUsed;
  if (source.tokenBudget !== undefined) entry.tokenBudget = source.tokenBudget;
  return entry;
}

/** One goal is recorded once, however often its transcript is replayed. */
function historyKey(entry: TerminalGoalHistoryEntry): string {
  return `${entry.provider}\u0000${entry.setAt}\u0000${entry.objective}`;
}

const ENDINGS: ReadonlySet<string> = new Set<TerminalGoalEnding>(['complete', 'failed', 'cleared', 'replaced']);
const PROVIDERS: ReadonlySet<string> = new Set<TerminalGoalProvider>(['claude-code', 'codex']);

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Reads a stored history defensively; malformed entries are dropped. */
export function parseTerminalGoalHistory(value: unknown): TerminalGoalHistoryEntry[] {
  if (!Array.isArray(value)) return [];
  const entries: TerminalGoalHistoryEntry[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const raw = item as Record<string, unknown>;
    const setAt = optionalNumber(raw.setAt);
    const endedAt = optionalNumber(raw.endedAt);
    if (
      typeof raw.provider !== 'string' || !PROVIDERS.has(raw.provider)
      || typeof raw.objective !== 'string' || !raw.objective
      || typeof raw.ending !== 'string' || !ENDINGS.has(raw.ending)
      || setAt === undefined || endedAt === undefined
    ) continue;
    const entry: TerminalGoalHistoryEntry = {
      provider: raw.provider as TerminalGoalProvider,
      objective: raw.objective,
      ending: raw.ending as TerminalGoalEnding,
      setAt,
      endedAt,
    };
    const iterations = optionalNumber(raw.iterations);
    const elapsedSeconds = optionalNumber(raw.elapsedSeconds);
    const tokensUsed = optionalNumber(raw.tokensUsed);
    const tokenBudget = optionalNumber(raw.tokenBudget);
    if (iterations !== undefined) entry.iterations = iterations;
    if (typeof raw.lastReason === 'string' && raw.lastReason) entry.lastReason = raw.lastReason;
    if (elapsedSeconds !== undefined) entry.elapsedSeconds = elapsedSeconds;
    if (tokensUsed !== undefined) entry.tokensUsed = tokensUsed;
    if (tokenBudget !== undefined) entry.tokenBudget = tokenBudget;
    entries.push(entry);
  }
  return entries;
}

/**
 * `existing` with `added` merged in: newest first, one entry per goal, at most
 * TERMINAL_GOAL_HISTORY_LIMIT. Returns null when nothing changed.
 */
export function mergeTerminalGoalHistory(
  existing: readonly TerminalGoalHistoryEntry[],
  added: readonly TerminalGoalHistoryEntry[],
): TerminalGoalHistoryEntry[] | null {
  const byKey = new Map<string, TerminalGoalHistoryEntry>();
  for (const entry of existing) byKey.set(historyKey(entry), entry);
  let changed = false;
  for (const entry of added) {
    const key = historyKey(entry);
    if (byKey.has(key)) continue;
    byKey.set(key, entry);
    changed = true;
  }
  if (!changed) return null;
  const merged = [...byKey.values()]
    .sort((a, b) => b.endedAt - a.endedAt)
    .slice(0, TERMINAL_GOAL_HISTORY_LIMIT);
  // Every added entry was older than the kept ten.
  return merged.some((entry) => added.includes(entry)) ? merged : null;
}
