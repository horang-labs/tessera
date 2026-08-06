/**
 * Which single Git verb the panel's main button offers right now
 * (`docs/design/git-delivery.md` §3, ADR 0007).
 *
 * A pure function over a state snapshot, kept out of the component tree so the
 * ladder can be read — and tested — as one piece rather than inferred from JSX.
 * Its input space is combinatorial and its output drives the only Git control
 * the user has, so it is exercised directly.
 *
 * Labels are i18n keys rather than words: this module answers the same question
 * for the renderer and for the server, and only one of the two has a language.
 */

import type { GitPanelData } from "@/types/git";

/** What the button says. `publish` and `push` run the same action (§2). */
export type GitPrimaryActionKind = 'commit' | 'push' | 'publish' | 'pull';

export interface GitStateSnapshot {
  /** Null on a detached HEAD, where there is no branch to push. */
  branch: string | null;
  /** The tracking branch, or null when this branch has never been published. */
  upstream: string | null;
  /** Commits this branch has that its upstream does not. */
  ahead: number;
  /** Commits the upstream has that this branch does not. */
  behind: number;
  /** Uncommitted entries in the working tree. */
  changedFileCount: number;
  /** False when the repository has no remote to push to at all. */
  hasRemote: boolean;
  /**
   * The repository's default branch, as `origin/HEAD` points at it. Null when
   * that ref is not set — a repository Git was never told the answer for.
   *
   * The ladder never reads it: it is here because the confirmation in §8 asks
   * its question of the same state snapshot, and a second snapshot type would
   * mean translating the panel payload twice.
   */
  defaultBranch: string | null;
}

export type GitPrimaryActionLabelKey =
  | 'gitPanel.commit.button'
  | 'gitPanel.push.button'
  | 'gitPanel.push.publishButton'
  | 'gitPanel.pull.button';

export type GitPrimaryActionPendingLabelKey =
  | 'gitPanel.commit.buttonPending'
  | 'gitPanel.push.buttonPending'
  | 'gitPanel.push.publishButtonPending'
  | 'gitPanel.pull.buttonPending';

export type GitPrimaryActionReasonKey =
  | 'gitPanel.primary.stateUnknown'
  | 'gitPanel.primary.detachedHead'
  | 'gitPanel.primary.noRemote'
  | 'gitPanel.push.nothingToPush';

export interface GitPrimaryAction {
  kind: GitPrimaryActionKind;
  /** What the action route is asked to run. */
  action: 'commit' | 'push' | 'pull';
  enabled: boolean;
  labelKey: GitPrimaryActionLabelKey;
  /**
   * What the label interpolates, where the count is worth saying before the
   * button is pressed (§4). Absent on the rungs whose label is a bare verb.
   */
  labelParams?: { count: number };
  pendingLabelKey: GitPrimaryActionPendingLabelKey;
  /** Why the button cannot be pressed; null while it can. */
  disabledReasonKey: GitPrimaryActionReasonKey | null;
}

/**
 * What the panel knows, in the terms the ladder asks its questions in. It sits
 * here rather than in the panel component because two of the three translations
 * are ones a caller would get wrong by reading the payload literally:
 *
 * - `branch` is a *display* string, and a detached HEAD is spelled
 *   `detached@<sha>` in it. Taken at face value it is a branch name, and the
 *   ladder would offer to publish it.
 * - `remoteUrl` is `git remote get-url origin` alone, so a repository whose
 *   remote is named anything else reads as having none — and the button would
 *   sit permanently disabled saying so, on a repository that can push perfectly
 *   well.
 *
 * `null` in, `null` out: no panel data is the unknown rung.
 */
export function gitStateSnapshotFromPanel(
  panel: GitPanelData | null | undefined,
): GitStateSnapshot | null {
  if (!panel) return null;

  return {
    branch: panel.detached ? null : panel.branch || null,
    upstream: panel.upstream,
    ahead: panel.ahead,
    behind: panel.behind,
    // The uncapped count: a file list truncated for display is still a dirty
    // tree, and the commit rung must not vanish because there is too much to
    // show.
    changedFileCount: panel.changedFilesTotal ?? panel.changedFiles.length,
    hasRemote: panel.hasRemote,
    defaultBranch: panel.defaultBranch,
  };
}

/**
 * `null` means the panel has no Git state for this session yet.
 *
 * It gets a disabled Commit rather than being folded into "nothing to do":
 * Tessera switches sessions constantly and loads Git state asynchronously, so
 * the alternative is the button flashing through an action the user never
 * pressed on every switch (ADR 0007).
 */
export function derivePrimaryGitAction(
  snapshot: GitStateSnapshot | null,
): GitPrimaryAction {
  if (!snapshot) return commitAction(false, 'gitPanel.primary.stateUnknown');

  // The dirty rung comes first, and it is the one rung a detached HEAD keeps:
  // committing without a branch is ordinary, pushing without one is not.
  if (snapshot.changedFileCount > 0) return commitAction(true, null);

  const blocked = describeRemoteObstacle(snapshot);

  // Above the ahead rung, and only ever with an upstream to pull from: a branch
  // that is behind cannot fast-forward its own push anyway, and one that has
  // never been published has nothing to be behind (§3).
  if (!blocked && snapshot.upstream && snapshot.behind > 0) {
    return pullAction(snapshot.behind);
  }

  if (!snapshot.upstream) return publishAction(!blocked, blocked);

  return pushAction(
    !blocked && snapshot.ahead > 0,
    blocked ?? (snapshot.ahead > 0 ? null : 'gitPanel.push.nothingToPush'),
  );
}

/** What stops this branch reaching a remote at all, before counting commits. */
function describeRemoteObstacle(
  snapshot: GitStateSnapshot,
): GitPrimaryActionReasonKey | null {
  if (!snapshot.branch) return 'gitPanel.primary.detachedHead';
  if (!snapshot.hasRemote) return 'gitPanel.primary.noRemote';
  return null;
}

function commitAction(
  enabled: boolean,
  disabledReasonKey: GitPrimaryActionReasonKey | null,
): GitPrimaryAction {
  return {
    kind: 'commit',
    action: 'commit',
    enabled,
    labelKey: 'gitPanel.commit.button',
    pendingLabelKey: 'gitPanel.commit.buttonPending',
    disabledReasonKey,
  };
}

function pushAction(
  enabled: boolean,
  disabledReasonKey: GitPrimaryActionReasonKey | null,
): GitPrimaryAction {
  return {
    kind: 'push',
    action: 'push',
    enabled,
    labelKey: 'gitPanel.push.button',
    pendingLabelKey: 'gitPanel.push.buttonPending',
    disabledReasonKey,
  };
}

function publishAction(
  enabled: boolean,
  disabledReasonKey: GitPrimaryActionReasonKey | null,
): GitPrimaryAction {
  return {
    kind: 'publish',
    action: 'push',
    enabled,
    labelKey: 'gitPanel.push.publishButton',
    pendingLabelKey: 'gitPanel.push.publishButtonPending',
    disabledReasonKey,
  };
}

/**
 * Always enabled: this rung exists only because there are commits to bring in,
 * and the count it carries is the reason it is offered rather than decoration.
 */
function pullAction(behind: number): GitPrimaryAction {
  return {
    kind: 'pull',
    action: 'pull',
    enabled: true,
    labelKey: 'gitPanel.pull.button',
    labelParams: { count: behind },
    pendingLabelKey: 'gitPanel.pull.buttonPending',
    disabledReasonKey: null,
  };
}
