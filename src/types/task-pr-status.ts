/**
 * PR (pull request) status attached to a task.
 *
 * `state` is derived from GitHub. `unsupported: true` means this task's
 * worktree is not tied to a GitHub remote (or `gh` is unavailable) — the
 * UI should not show "pending PR" hints in that case.
 */

export type TaskPrState = 'open' | 'merged' | 'closed';

export interface TaskPrStatus {
  number: number;
  url: string;
  state: TaskPrState;
  mergedAt?: string;
  lastSynced: string;
  /**
   * Head commit SHA of the PR's source branch as last reported by GitHub.
   * Compared against the worktree's current HEAD to detect new work pushed
   * after the PR was merged/closed.
   */
  headRefOid?: string;
}

export interface TaskPrStatusSummary {
  prStatus?: TaskPrStatus;
  /** True when we confirmed this task cannot have PR sync (not GitHub / no gh / no branch). */
  prUnsupported: boolean;
}
