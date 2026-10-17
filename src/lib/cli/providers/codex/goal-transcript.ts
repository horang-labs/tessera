import type { TerminalGoalSnapshot, TerminalGoalStatus } from '@/types/terminal-goal';

/**
 * Codex keeps the authoritative goal in `$CODEX_HOME/goals_1.sqlite`, but that
 * WAL database is not safely readable from a Windows server across the WSL
 * bridge. The rollout carries the same lifecycle (CLI 0.162):
 *
 * - `event_msg` / `thread_goal_updated` — set, pause, resume, budget/usage limits.
 * - `update_goal` tool output (`{"goal":{...}}`) — the model marking it complete.
 *   That transition is not echoed as a `thread_goal_updated` event.
 * - a user `<codex_internal_context source="user_goal">` message containing
 *   `User cleared the goal.` — `/goal clear`, which has no event either.
 */

const GOAL_EVENT_MARKER = '"thread_goal_updated"';
const GOAL_CLEARED_MARKER = 'User cleared the goal.';
/** A goal object serialized inside a tool output string. */
const GOAL_TOOL_OUTPUT_MARKER = '\\"goal\\":{';

const STATUSES: ReadonlySet<string> = new Set<TerminalGoalStatus>([
  'active',
  'paused',
  'blocked',
  'usage_limited',
  'budget_limited',
  'complete',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Codex reports goal times in epoch seconds; Tessera keeps epoch ms. */
function toEpochMs(value: unknown): number | undefined {
  const n = readNumber(value);
  if (n === undefined) return undefined;
  return n < 1e12 ? n * 1000 : n;
}

function readTimestamp(value: unknown, fallback: number): number {
  if (typeof value !== 'string') return fallback;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function snapshotFromGoal(goal: unknown, at: number): TerminalGoalSnapshot | undefined {
  if (!isRecord(goal)) return undefined;
  const objective = typeof goal.objective === 'string' ? goal.objective.trim() : '';
  const status = typeof goal.status === 'string' ? goal.status : '';
  if (!objective || !STATUSES.has(status)) return undefined;

  const snapshot: TerminalGoalSnapshot = {
    provider: 'codex',
    objective,
    status: status as TerminalGoalStatus,
    setAt: toEpochMs(goal.createdAt) ?? at,
    updatedAt: toEpochMs(goal.updatedAt) ?? at,
  };
  const elapsedSeconds = readNumber(goal.timeUsedSeconds);
  const tokensUsed = readNumber(goal.tokensUsed);
  const tokenBudget = readNumber(goal.tokenBudget);
  if (elapsedSeconds !== undefined) snapshot.elapsedSeconds = elapsedSeconds;
  if (tokensUsed !== undefined) snapshot.tokensUsed = tokensUsed;
  if (tokenBudget !== undefined) snapshot.tokenBudget = tokenBudget;
  return snapshot;
}

function textParts(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (!Array.isArray(value)) return [];
  const parts: string[] = [];
  for (const item of value) {
    if (isRecord(item) && typeof item.text === 'string') parts.push(item.text);
  }
  return parts;
}

function goalFromToolOutput(output: unknown, at: number): TerminalGoalSnapshot | undefined {
  for (const text of textParts(output)) {
    const trimmed = text.trim();
    if (!trimmed.startsWith('{') || !trimmed.includes('"goal"')) continue;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (isRecord(parsed)) {
        const snapshot = snapshotFromGoal(parsed.goal, at);
        if (snapshot) return snapshot;
      }
    } catch {
      // Not the update_goal result; tool output is free-form text.
    }
  }
  return undefined;
}

function isGoalClearedMessage(payload: Record<string, unknown>): boolean {
  if (payload.type !== 'message' || payload.role !== 'user') return false;
  return textParts(payload.content).some((text) => (
    text.includes('source="user_goal"') && text.includes(GOAL_CLEARED_MARKER)
  ));
}

/**
 * Folds one rollout line into the current goal.
 * Returns `undefined` when the line says nothing about the goal, `null` when it
 * clears the goal, and the next snapshot otherwise.
 */
export function reduceCodexGoalTranscriptLine(
  current: TerminalGoalSnapshot | null,
  line: string,
  now = Date.now(),
): TerminalGoalSnapshot | null | undefined {
  if (
    !line.includes(GOAL_EVENT_MARKER)
    && !line.includes(GOAL_CLEARED_MARKER)
    && !line.includes(GOAL_TOOL_OUTPUT_MARKER)
  ) {
    return undefined;
  }

  let entry: unknown;
  try {
    entry = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!isRecord(entry) || !isRecord(entry.payload)) return undefined;
  const payload = entry.payload;
  const at = readTimestamp(entry.timestamp, now);

  if (entry.type === 'event_msg' && payload.type === 'thread_goal_updated') {
    return snapshotFromGoal(payload.goal, at);
  }

  if (entry.type !== 'response_item') return undefined;

  if (isGoalClearedMessage(payload)) return null;

  if (payload.type === 'custom_tool_call_output' || payload.type === 'function_call_output') {
    const snapshot = goalFromToolOutput(payload.output, at);
    // A tool result for an older goal must not resurrect it.
    if (!snapshot || (current && current.objective !== snapshot.objective)) return undefined;
    return snapshot;
  }

  return undefined;
}
