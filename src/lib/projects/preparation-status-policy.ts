/**
 * The rules governing a worktree's preparation status.
 *
 * Preparation is one run at a time whose outcome outlives it: a failure has to
 * stay on the worktree until someone deals with it, because the alternative is
 * a user working in a half-prepared worktree without knowing. Everything here
 * is pure — the caller reads the stored status, asks what an event does to it,
 * and writes back only what was accepted.
 */

export const PREPARATION_STATUSES = [
  'never_run',
  'running',
  'succeeded',
  'failed',
] as const;

export type PreparationStatus = (typeof PREPARATION_STATUSES)[number];

/**
 * Preparation runs in two stages, and which one is in flight decides whether an
 * agent may start.
 *
 * `before` holds the work an agent cannot start without — copying in the files
 * a CLI reads at startup, such as CLAUDE.md or AGENTS.md. A CLI that starts
 * first never sees them, and nothing later puts them into its context, so this
 * stage has to finish before one is spawned.
 *
 * `after` holds the rest: installing dependencies, warming caches — work a
 * worktree needs but an agent does not have to wait on. Splitting the script in
 * two is what keeps the wait as short as the work that actually blocks.
 */
export const PREPARATION_PHASES = ['before', 'after'] as const;

export type PreparationPhase = (typeof PREPARATION_PHASES)[number];

export type PreparationEvent =
  /** A run is about to be spawned, whether the first one or a re-run. */
  | { kind: 'start' }
  /** The run's process ended, and its exit code says how. */
  | { kind: 'finish'; exitCode: number }
  /** The app went away while the run was in flight, so its outcome is lost. */
  | { kind: 'interrupt' };

export interface PreparationTransition {
  /**
   * False when the event does not apply to the current status. The status comes
   * back unchanged, and the caller writes nothing.
   */
  accepted: boolean;
  status: PreparationStatus;
}

/** What a status stored before this feature existed, or corrupted, means. */
export function readPreparationStatus(stored: string | null | undefined): PreparationStatus {
  return (PREPARATION_STATUSES as readonly string[]).includes(stored ?? '')
    ? (stored as PreparationStatus)
    : 'never_run';
}

/**
 * What a stored phase means.
 *
 * A run recorded before the split had no phase, and everything it ran was the
 * whole script — which is now the `before` stage. Reading the missing value as
 * `before` keeps those runs describing themselves correctly.
 */
export function readPreparationPhase(stored: string | null | undefined): PreparationPhase {
  return (PREPARATION_PHASES as readonly string[]).includes(stored ?? '')
    ? (stored as PreparationPhase)
    : 'before';
}

/**
 * Resolve what an event does to a preparation status.
 *
 * Only a run in flight can complete. That single rule is what keeps a failure
 * from being cleared by anything other than a re-run that finished: a late
 * completion arriving from a run that is no longer the current one finds a
 * terminal status and is refused.
 */
export function applyPreparationEvent(
  current: PreparationStatus,
  event: PreparationEvent,
): PreparationTransition {
  switch (event.kind) {
    case 'start':
      // Starting a second run alongside a live one would leave two processes
      // writing into the same worktree.
      return current === 'running'
        ? { accepted: false, status: current }
        : { accepted: true, status: 'running' };

    case 'finish':
      if (current !== 'running') return { accepted: false, status: current };
      return { accepted: true, status: event.exitCode === 0 ? 'succeeded' : 'failed' };

    case 'interrupt':
      // An unknown outcome is treated as a failure: the worktree may well be
      // half prepared, and that is precisely what has to stay visible.
      if (current !== 'running') return { accepted: false, status: current };
      return { accepted: true, status: 'failed' };
  }
}

export interface PreparationStageOutcome {
  status: PreparationStatus;
  /** The stage to run next, or null when the run is over either way. */
  nextPhase: PreparationPhase | null;
}

/**
 * What the end of one stage does to the run as a whole.
 *
 * A `before` stage that succeeded hands over to `after` and the run carries on,
 * which is why the status stays `running` — the agent is already released by
 * then, because releasing it is exactly what finishing `before` means.
 *
 * A `before` stage that failed ends the run there. Whatever `after` would have
 * installed, it would be installing it on top of a worktree that is already
 * missing something, and the failure to report is the one that happened first.
 */
export function resolveStageCompletion(args: {
  phase: PreparationPhase;
  exitCode: number;
  /** Whether the project has an `after` script at all. */
  hasAfterScript: boolean;
}): PreparationStageOutcome {
  if (args.exitCode !== 0) return { status: 'failed', nextPhase: null };
  if (args.phase === 'before' && args.hasAfterScript) {
    return { status: 'running', nextPhase: 'after' };
  }
  return { status: 'succeeded', nextPhase: null };
}

/**
 * Whether an agent has to wait before it may be spawned.
 *
 * Only a `before` stage still running holds one back. A failed `before` does
 * not: the agent starts anyway, because the alternative is a prompt that was
 * sent and then silently does nothing, with no way to tell why. The badge and
 * the Scripts tab are what report the failure instead.
 */
export function blocksAgentStartup(
  status: PreparationStatus,
  phase: PreparationPhase,
): boolean {
  return status === 'running' && phase === 'before';
}

/** Whether preparation can be run again as things stand. */
export function canRerunPreparation(current: PreparationStatus): boolean {
  return applyPreparationEvent(current, { kind: 'start' }).accepted;
}

/**
 * The badge a status calls for, or null for no badge at all.
 *
 * A worktree that prepared successfully is simply a working worktree, so it
 * carries no mark; neither does one whose project has nothing to prepare.
 */
export function resolvePreparationBadge(
  current: PreparationStatus,
): 'running' | 'failed' | null {
  switch (current) {
    case 'running':
      return 'running';
    case 'failed':
      return 'failed';
    case 'never_run':
    case 'succeeded':
      return null;
  }
}
