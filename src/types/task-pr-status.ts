/**
 * PR (pull request) status attached to a task.
 *
 * `state` is derived from GitHub. `unsupported: true` means this task's
 * worktree is not tied to a GitHub remote (or `gh` is unavailable) — the
 * UI should not show "pending PR" hints in that case.
 */

export type TaskPrState = 'open' | 'merged' | 'closed';
export type TaskPrRelation = 'current' | 'historical';

export interface TaskPrStatus {
  number: number;
  url: string;
  state: TaskPrState;
  /** Whether this PR still represents the worktree's current revision. */
  relation: TaskPrRelation;
  mergedAt?: string;
  lastSynced: string;
  /**
   * Head commit SHA of the PR's source branch as last reported by GitHub.
   * Compared against the worktree's current HEAD to detect new work pushed
   * after the PR was merged/closed.
   */
  headRefOid?: string;
}

/**
 * Runtime payloads and rows written by older Tessera builds have no relation.
 * Treat open/merged conservatively as current until the next successful probe;
 * closed PRs are always history and can never block a new PR.
 */
export function effectiveTaskPrRelation(
  status: Pick<TaskPrStatus, 'state'> & { relation?: TaskPrRelation },
): TaskPrRelation {
  return status.relation ?? (status.state === 'closed' ? 'historical' : 'current');
}

export function isCurrentTaskPr(
  status: Pick<TaskPrStatus, 'state'> & { relation?: TaskPrRelation },
): boolean {
  return effectiveTaskPrRelation(status) === 'current';
}

export interface TaskPrStatusSummary {
  prStatus?: TaskPrStatus;
  /** True only after a successful, current probe. Transient failures set this false. */
  prStatusKnown: boolean;
  /** True when we confirmed this task cannot have PR sync (not GitHub / no gh / no branch). */
  prUnsupported: boolean;
}
