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
