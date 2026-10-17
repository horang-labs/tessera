import type { TerminalGoalSnapshot } from '@/types/terminal-goal';

/**
 * Claude Code records `/goal` as `attachment` lines of type `goal_status`
 * (CLI 2.1.x). The goal itself is a session-scoped Stop hook, so the
 * transcript is the only place its lifecycle is written down:
 *
 * - `{ sentinel: true, met: false, condition }` — goal set.
 * - `{ sentinel: true, met: true, condition }`  — goal cleared (`/goal clear`).
 * - `{ met: false, condition, reason }`          — evaluator said "not yet";
 *   Claude keeps working.
 * - `{ met: true, condition, reason, iterations, durationMs, tokens }` — achieved.
 * - `{ met: false, failed: true, ... }`          — evaluator judged it impossible.
 */

/** Cheap prefilter so a multi-megabyte transcript is not JSON-parsed line by line. */
export const CLAUDE_GOAL_LINE_MARKER = '"goal_status"';

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readTimestamp(value: unknown, fallback: number): number {
  if (typeof value !== 'string') return fallback;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Folds one transcript line into the current goal.
 * Returns `undefined` when the line says nothing about the goal, `null` when it
 * clears the goal, and the next snapshot otherwise.
 */
export function reduceClaudeGoalTranscriptLine(
  current: TerminalGoalSnapshot | null,
  line: string,
  now = Date.now(),
): TerminalGoalSnapshot | null | undefined {
  if (!line.includes(CLAUDE_GOAL_LINE_MARKER)) return undefined;

  let entry: unknown;
  try {
    entry = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!isRecord(entry) || entry.type !== 'attachment' || entry.isSidechain === true) {
    return undefined;
  }
  const attachment = entry.attachment;
  if (!isRecord(attachment) || attachment.type !== 'goal_status') return undefined;

  const at = readTimestamp(entry.timestamp, now);
  const condition = typeof attachment.condition === 'string' ? attachment.condition.trim() : '';
  const reason = typeof attachment.reason === 'string' && attachment.reason.trim()
    ? attachment.reason.trim()
    : undefined;

  if (attachment.sentinel === true) {
    if (attachment.met === true) return null;
    if (!condition) return undefined;
    return {
      provider: 'claude-code',
      objective: condition,
      status: 'active',
      setAt: at,
      updatedAt: at,
      iterations: 0,
    };
  }

  // An evaluation of a goal this reader never saw being set (the transcript was
  // picked up mid-goal, or the set line was compacted away) still describes it.
  const base: TerminalGoalSnapshot = current && (!condition || current.objective === condition)
    ? current
    : {
        provider: 'claude-code',
        objective: condition,
        status: 'active',
        setAt: at,
        updatedAt: at,
        iterations: 0,
      };
  if (!base.objective) return undefined;

  const iterations = readNumber(attachment.iterations);
  const durationMs = readNumber(attachment.durationMs);
  const tokens = readNumber(attachment.tokens);
  const ended = attachment.met === true || attachment.failed === true;

  const next: TerminalGoalSnapshot = {
    ...base,
    status: attachment.failed === true ? 'failed' : attachment.met === true ? 'complete' : 'active',
    updatedAt: at,
    iterations: iterations ?? (base.iterations ?? 0) + (ended ? 0 : 1),
  };
  if (reason) next.lastReason = reason;
  if (durationMs !== undefined) next.elapsedSeconds = Math.round(durationMs / 1000);
  if (tokens !== undefined) next.tokensUsed = tokens;
  return next;
}
