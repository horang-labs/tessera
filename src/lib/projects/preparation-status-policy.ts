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
