import fsp from 'node:fs/promises';
import logger from '@/lib/logger';
import { readCodexTurnBoundary } from '@/lib/cli/providers/codex/goal-transcript';
import {
  buildTerminalGoalHistoryEntry,
  isActiveTerminalGoal,
  isLiveTerminalGoal,
  sameTerminalGoal,
  terminalGoalEnding,
  type TerminalGoalHistoryEntry,
  type TerminalGoalSnapshot,
} from '@/types/terminal-goal';

/**
 * Tracks the `/goal` each PTY session is pursuing by tailing the provider's
 * transcript.
 *
 * Neither Claude Code nor Codex reports `/goal` through a hook: it is a TUI
 * command, and both CLIs write its lifecycle only into the transcript they
 * already keep. Hooks still tell us *when* to look — every tool call and turn
 * boundary arrives as one — so each hook triggers an incremental read from the
 * last offset. While a goal is live the file is also polled, because pausing or
 * clearing it at an idle prompt fires no hook at all.
 *
 * The tracker also owns the one lifecycle rule a goal changes: a Stop is not
 * the end of the work while the CLI is about to continue toward the goal.
 * Claude evaluates the goal *after* the Stop hooks fire (the goal is itself a
 * Stop hook running beside Tessera's), and Codex starts its own continuation
 * turn. `holdCompletion` defers the completed state until the transcript shows
 * the goal ended, or new activity shows the work continued.
 */

export interface TerminalGoalTarget {
  sessionId: string;
  terminalId: string;
  userId: string;
  providerId: string;
  providerSessionId: string;
  /** Hook-reported transcript path (agent-side syntax), when one was captured. */
  transcriptPath: string | null;
}

export interface TerminalGoalTrackerDeps {
  resolveTranscriptFile(target: TerminalGoalTarget): Promise<string | null>;
  /**
   * Substrings every goal line contains. Lines without one are never decoded,
   * which keeps a gigabyte transcript off the event loop. Absent: decode all.
   */
  lineMarkers?(providerId: string): readonly string[] | undefined;
  reduceLine(
    providerId: string,
    current: TerminalGoalSnapshot | null,
    line: string,
  ): TerminalGoalSnapshot | null | undefined;
  /** False once the pane no longer runs this session. */
  isLive(target: TerminalGoalTarget): boolean;
  publish(target: TerminalGoalTarget, goal: TerminalGoalSnapshot | null): void;
  /**
   * A goal just became active (set or resumed). The CLI starts a turn for it
   * without a UserPromptSubmit, so this is the only "turn started" signal.
   */
  onGoalStarted?(target: TerminalGoalTarget, goal: TerminalGoalSnapshot): void;
  /** A failed/aborted Codex turn has no Stop, regardless of goal state. */
  onTurnEnded?(target: TerminalGoalTarget, boundary: { stateAt: number; preview?: string }): void;
  /**
   * Goals the transcript just showed ending (achieved, impossible, cleared or
   * replaced by another), oldest first. A replay reports the ends it covers
   * again, so the receiver must deduplicate.
   */
  recordEndedGoals?(target: TerminalGoalTarget, entries: TerminalGoalHistoryEntry[]): void;
}

export interface CompletionHoldHandlers {
  /** The goal ended (or the hold timed out): the deferred Stop really completed. */
  release: () => void;
  /** The CLI continued toward the goal: the Stop was not a completion. */
  onContinue?: () => void;
}

interface CompletionHold extends CompletionHoldHandlers {
  baselineIterations: number;
  timer: ReturnType<typeof setTimeout>;
}

interface TrackedGoal {
  target: TerminalGoalTarget;
  filePath: string | null;
  /** Byte offset just past the last complete line consumed. */
  offset: number;
  /** Whether the history before `offset` has been replayed once. */
  replayed: boolean;
  goal: TerminalGoalSnapshot | null;
  /** Whether subscribers currently hold a non-null goal for this session. */
  published: boolean;
  refreshing: Promise<void> | null;
  /** A refresh was requested while one was in flight. */
  dirty: boolean;
  pollTimer?: ReturnType<typeof setTimeout>;
  hold?: CompletionHold;
  /** When a hook last asked for a read. */
  observedAt: number;
}

const READ_CHUNK_BYTES = 1024 * 1024;
/**
 * How much history the first read replays, from the end of the transcript.
 * Long sessions reach gigabytes, and a full replay over the WSL bridge took
 * seconds per file while stalling the event loop for every terminal. A goal
 * set further back is still picked up by its next record (Claude writes one
 * per evaluation; Codex on pause, resume, limits and completion).
 */
export const GOAL_INITIAL_REPLAY_BYTES = 16 * 1024 * 1024;
const NEWLINE = 0x0a;
/** Catches pause/clear at an idle prompt, which no hook reports. */
export const GOAL_POLL_MS = 2_500;
/** Catches `/goal` typed at an idle prompt before the turn's first hook. */
export const GOAL_IDLE_POLL_MS = 4_000;
/**
 * Right after a hook the CLI is usually still writing: Claude records the goal
 * a moment after UserPromptSubmit fires. Look again soon instead of waiting
 * for the next idle poll.
 */
export const GOAL_ACTIVITY_POLL_MS = 600;
const GOAL_ACTIVITY_WINDOW_MS = 5_000;
/** A goal record older than this on first sight is history, not a new start. */
export const GOAL_START_RECENCY_MS = 30_000;
/** Faster while a Stop waits for Claude's evaluator verdict. */
export const GOAL_HOLD_POLL_MS = 750;
/** Upper bound on deferring a Stop, in case the verdict never lands. */
export const GOAL_HOLD_MAX_MS = 120_000;

/**
 * The lines of `block` (complete lines, no trailing newline) that contain a
 * marker, in file order. Only those lines are decoded.
 */
function goalLines(block: Buffer, markers: Buffer[] | undefined): string[] {
  if (!markers) return block.toString('utf8').split('\n').filter(Boolean);
  const starts = new Set<number>();
  for (const marker of markers) {
    let from = 0;
    for (;;) {
      const hit = block.indexOf(marker, from);
      if (hit < 0) break;
      const start = hit === 0 ? 0 : block.lastIndexOf(NEWLINE, hit) + 1;
      starts.add(start);
      const end = block.indexOf(NEWLINE, hit);
      if (end < 0) break;
      from = end + 1;
    }
  }
  return [...starts].sort((a, b) => a - b).map((start) => {
    const end = block.indexOf(NEWLINE, start);
    return block.subarray(start, end < 0 ? block.length : end).toString('utf8');
  });
}

/** When a transcript line was written, for a clear that carries no snapshot. */
function lineTimestamp(line: string, fallback: number): number {
  try {
    const parsed = JSON.parse(line) as { timestamp?: unknown };
    const at = typeof parsed.timestamp === 'string' ? Date.parse(parsed.timestamp) : NaN;
    return Number.isFinite(at) ? at : fallback;
  } catch {
    return fallback;
  }
}

function endedAtOf(next: TerminalGoalSnapshot | null, line: string): number {
  if (!next) return lineTimestamp(line, Date.now());
  // Replaced: when the next goal was set. Achieved/impossible: its verdict.
  return next.status === 'complete' || next.status === 'failed' ? next.updatedAt : next.setAt;
}

function keyOf(userId: string, sessionId: string): string {
  return `${userId}\u0000${sessionId}`;
}

export class TerminalGoalTracker {
  private readonly tracked = new Map<string, TrackedGoal>();
  constructor(private readonly deps: TerminalGoalTrackerDeps) {}

  /**
   * Records the latest identity reported for a session and reads whatever the
   * transcript gained since the last look. Resolves once the read is done.
   */
  observe(target: TerminalGoalTarget): Promise<void> {
    const key = keyOf(target.userId, target.sessionId);
    let entry = this.tracked.get(key);
    if (!entry) {
      entry = {
        target,
        filePath: null,
        offset: 0,
        replayed: false,
        goal: null,
        published: false,
        refreshing: null,
        dirty: false,
        observedAt: Date.now(),
      };
      this.tracked.set(key, entry);
    } else {
      const previous = entry.target;
      const conversationChanged = previous.providerSessionId !== target.providerSessionId;
      const pathChanged = (target.transcriptPath ?? null) !== (previous.transcriptPath ?? null);
      entry.target = {
        ...target,
        transcriptPath: target.transcriptPath ?? previous.transcriptPath,
      };
      if (conversationChanged) {
        // /clear or a resume onto another conversation: the old goal belonged
        // to the previous transcript.
        entry.filePath = null;
        entry.offset = 0;
        this.cancelHold(entry);
        this.setGoal(entry, null);
      } else if (pathChanged && target.transcriptPath) {
        entry.filePath = null;
      }
      entry.observedAt = Date.now();
    }
    return this.refresh(entry);
  }

  getGoal(userId: string, sessionId: string): TerminalGoalSnapshot | null {
    return this.tracked.get(keyOf(userId, sessionId))?.goal ?? null;
  }

  /** Snapshot messages for a new connection (only live sessions with a goal). */
  getGoalsForUser(userId: string): Array<{ target: TerminalGoalTarget; goal: TerminalGoalSnapshot }> {
    const result: Array<{ target: TerminalGoalTarget; goal: TerminalGoalSnapshot }> = [];
    for (const entry of this.tracked.values()) {
      if (entry.target.userId !== userId || !entry.goal) continue;
      if (!this.deps.isLive(entry.target)) continue;
      result.push({ target: entry.target, goal: entry.goal });
    }
    return result;
  }

  /**
   * Defers a Stop's completed state while an active goal may keep the CLI
   * working. Returns false (caller completes now) when no active goal applies.
   * Call after `observe` so the goal reflects the transcript at Stop time.
   */
  holdCompletion(userId: string, sessionId: string, handlers: CompletionHoldHandlers): boolean {
    const entry = this.tracked.get(keyOf(userId, sessionId));
    if (!entry || !isActiveTerminalGoal(entry.goal)) return false;
    this.cancelHold(entry);
    entry.hold = {
      ...handlers,
      baselineIterations: entry.goal?.iterations ?? 0,
      timer: setTimeout(() => this.releaseHold(entry), GOAL_HOLD_MAX_MS),
    };
    this.schedulePoll(entry);
    return true;
  }

  /** New lead activity proves the work continued past the held Stop. */
  noteActivity(userId: string, sessionId: string): void {
    const entry = this.tracked.get(keyOf(userId, sessionId));
    if (entry) this.continueHold(entry);
  }

  /**
   * A user prompt resumes a goal Claude paused ("send a message to continue").
   * Claude writes no record for the resume, so the prompt itself is the signal.
   * Codex is different: its paused goal waits for `/goal resume`.
   */
  noteUserPrompt(userId: string, sessionId: string): void {
    const entry = this.tracked.get(keyOf(userId, sessionId));
    if (!entry?.goal || entry.goal.provider !== 'claude-code' || entry.goal.status !== 'paused') return;
    this.setGoal(entry, { ...entry.goal, status: 'active', updatedAt: Date.now() });
    this.schedulePoll(entry);
  }

  isHoldingCompletion(userId: string, sessionId: string): boolean {
    return !!this.tracked.get(keyOf(userId, sessionId))?.hold;
  }

  forget(userId: string, sessionId: string): void {
    const key = keyOf(userId, sessionId);
    const entry = this.tracked.get(key);
    if (!entry) return;
    this.tracked.delete(key);
    if (entry.pollTimer) clearTimeout(entry.pollTimer);
    this.cancelHold(entry);
    if (entry.published) this.deps.publish(entry.target, null);
  }

  /** Stops every timer (tests, shutdown). */
  dispose(): void {
    for (const entry of this.tracked.values()) {
      if (entry.pollTimer) clearTimeout(entry.pollTimer);
      if (entry.hold) clearTimeout(entry.hold.timer);
    }
    this.tracked.clear();
  }

  private refresh(entry: TrackedGoal): Promise<void> {
    if (entry.refreshing) {
      entry.dirty = true;
      return entry.refreshing;
    }
    entry.refreshing = (async () => {
      try {
        do {
          entry.dirty = false;
          await this.readOnce(entry);
        } while (entry.dirty && this.tracked.get(this.keyFor(entry)) === entry);
      } catch (error) {
        logger.debug({
          sessionId: entry.target.sessionId,
          error: (error as Error).message,
        }, 'Terminal goal transcript read skipped');
      } finally {
        entry.refreshing = null;
      }
      if (this.tracked.get(this.keyFor(entry)) !== entry) return;
      this.evaluateHold(entry);
      this.schedulePoll(entry);
    })();
    return entry.refreshing;
  }

  private keyFor(entry: TrackedGoal): string {
    return keyOf(entry.target.userId, entry.target.sessionId);
  }

  private async readOnce(entry: TrackedGoal): Promise<void> {
    if (!this.deps.isLive(entry.target)) {
      this.forget(entry.target.userId, entry.target.sessionId);
      return;
    }
    if (!entry.filePath) {
      entry.filePath = await this.deps.resolveTranscriptFile(entry.target);
      entry.offset = 0;
      entry.replayed = false;
      if (!entry.filePath) return;
    }

    let size: number;
    try {
      size = (await fsp.stat(entry.filePath)).size;
    } catch {
      // Rotated or not yet created; resolve again next time.
      entry.filePath = null;
      return;
    }
    if (size < entry.offset) {
      // Rewritten in place (compaction/rewrite): replay again.
      entry.offset = 0;
      entry.replayed = false;
      this.setGoal(entry, null);
    }
    const replaying = !entry.replayed;
    // The first look replays only the tail; it starts mid-line, so the bytes
    // up to the first newline are skipped.
    let skipPartialLine = false;
    if (replaying && size - entry.offset > GOAL_INITIAL_REPLAY_BYTES) {
      entry.offset = size - GOAL_INITIAL_REPLAY_BYTES;
      skipPartialLine = true;
    }
    entry.replayed = true;
    if (size === entry.offset) return;

    const markers = this.deps.lineMarkers?.(entry.target.providerId)
      ?.map((marker) => Buffer.from(marker, 'utf8'));
    const handle = await fsp.open(entry.filePath, 'r');
    const startGoal = entry.goal;
    let goal = startGoal;
    const ended: TerminalGoalHistoryEntry[] = [];
    let turnBoundary: ReturnType<typeof readCodexTurnBoundary>;
    try {
      let position = entry.offset;
      let pending: Buffer = Buffer.alloc(0);
      while (position < size) {
        const length = Math.min(READ_CHUNK_BYTES, size - position);
        const chunk = Buffer.alloc(length);
        const { bytesRead } = await handle.read(chunk, 0, length, position);
        if (bytesRead <= 0) break;
        position += bytesRead;
        let data = pending.length
          ? Buffer.concat([pending, chunk.subarray(0, bytesRead)])
          : chunk.subarray(0, bytesRead);
        if (skipPartialLine) {
          const firstNewline = data.indexOf(NEWLINE);
          if (firstNewline < 0) {
            pending = Buffer.alloc(0);
            continue;
          }
          data = data.subarray(firstNewline + 1);
          skipPartialLine = false;
        }
        const lastNewline = data.lastIndexOf(NEWLINE);
        if (lastNewline < 0) {
          pending = data;
          continue;
        }
        // Split on bytes, not characters: a chunk boundary can fall inside a
        // multi-byte character, and only whole lines are decoded.
        for (const line of goalLines(data.subarray(0, lastNewline), markers)) {
          if (entry.target.providerId === 'codex') {
            turnBoundary = readCodexTurnBoundary(line) ?? turnBoundary;
          }
          const next = this.deps.reduceLine(entry.target.providerId, goal, line);
          if (next === undefined) continue;
          const ending = terminalGoalEnding(goal, next);
          if (goal && ending) {
            ended.push(buildTerminalGoalHistoryEntry(goal, next, ending, endedAtOf(next, line)));
          }
          goal = next;
        }
        pending = data.subarray(lastNewline + 1);
      }
      // A trailing partial line is re-read once the CLI finishes writing it.
      entry.offset = position - pending.length;
    } finally {
      await handle.close();
    }
    if (ended.length) this.deps.recordEndedGoals?.(entry.target, ended);
    // A resumed conversation replays its history. A goal that already ended
    // there is old news — the CLI itself only restores a live one.
    if (replaying && goal && !isLiveTerminalGoal(goal)) goal = null;
    // A prompt can resume a paused goal while this read is in flight. If the
    // transcript said nothing new, keep that newer state.
    if (goal === startGoal && entry.goal !== startGoal) return;
    if (turnBoundary?.ended && this.deps.isLive(entry.target)) {
      const { stateAt, preview } = turnBoundary;
      this.deps.onTurnEnded?.(entry.target, { stateAt, ...(preview ? { preview } : {}) });
    }
    this.setGoal(entry, goal);
  }

  private setGoal(entry: TrackedGoal, goal: TerminalGoalSnapshot | null): void {
    if (sameTerminalGoal(entry.goal, goal) && entry.published === !!goal) return;
    const previous = entry.goal;
    entry.goal = goal;
    if (!goal && !entry.published) return;
    entry.published = !!goal;
    this.deps.publish(entry.target, goal);
    if (
      goal
      && isActiveTerminalGoal(goal)
      && !isActiveTerminalGoal(previous)
      && Date.now() - goal.updatedAt <= GOAL_START_RECENCY_MS
    ) {
      this.deps.onGoalStarted?.(entry.target, goal);
    }
  }

  private evaluateHold(entry: TrackedGoal): void {
    const hold = entry.hold;
    if (!hold) return;
    if (!isActiveTerminalGoal(entry.goal)) {
      // Achieved, judged impossible, cleared, paused or limited: the CLI stops.
      this.releaseHold(entry);
      return;
    }
    if ((entry.goal?.iterations ?? 0) > hold.baselineIterations) {
      // Claude's evaluator said "not yet" — it is already working again.
      this.continueHold(entry);
    }
  }

  private continueHold(entry: TrackedGoal): void {
    const hold = entry.hold;
    if (!hold) return;
    this.cancelHold(entry);
    hold.onContinue?.();
  }

  private releaseHold(entry: TrackedGoal): void {
    const hold = entry.hold;
    if (!hold) return;
    this.cancelHold(entry);
    hold.release();
  }

  private cancelHold(entry: TrackedGoal): void {
    if (!entry.hold) return;
    clearTimeout(entry.hold.timer);
    entry.hold = undefined;
  }

  private schedulePoll(entry: TrackedGoal): void {
    if (entry.pollTimer) {
      clearTimeout(entry.pollTimer);
      entry.pollTimer = undefined;
    }
    const delay = entry.hold
      ? GOAL_HOLD_POLL_MS
      : Date.now() - entry.observedAt < GOAL_ACTIVITY_WINDOW_MS
        ? GOAL_ACTIVITY_POLL_MS
        : isLiveTerminalGoal(entry.goal)
          ? GOAL_POLL_MS
          : GOAL_IDLE_POLL_MS;
    entry.pollTimer = setTimeout(() => {
      entry.pollTimer = undefined;
      if (this.tracked.get(this.keyFor(entry)) !== entry) return;
      void this.refresh(entry);
    }, delay);
    entry.pollTimer.unref?.();
  }
}
