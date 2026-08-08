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

import type { GitConflictOperation, GitPanelData } from "@/types/git";
import { isCurrentTaskPr } from '@/types/task-pr-status';

/**
 * What the button says. `publish` and `push` run the same action (§2).
 *
 * `conflict` is the one kind that runs nothing: it is the commit path held
 * closed while a merge, rebase or cherry-pick is unfinished (§9). It is a kind
 * of its own rather than a disabled `commit` because the surfaces around the
 * button read the kind to decide whether to draw the commit form under it, and
 * a worktree whose commit cannot run must not be offered one to write.
 */
export type GitPrimaryActionKind =
  | 'commit'
  | 'conflict'
  | 'push'
  | 'publish'
  | 'pull'
  | 'create_pr';

/**
 * What the panel knows about a pull request for this branch. `unknown` is a
 * state of its own rather than a synonym for `none`: GitHub is asked over the
 * network, and answering "no pull request" before the answer arrives would put
 * an enabled Create PR under the cursor on every session switch (ADR 0007).
 */
export type GitPullRequestReadiness =
  | 'exists'
  | 'none'
  | 'unknown'
  /** Not a GitHub remote, or no `gh` to ask with — no pull request is possible. */
  | 'unsupported';

export interface GitStateSnapshot {
  /** Null on a detached HEAD, where there is no branch to push. */
  branch: string | null;
  /** The tracking branch, or null when this branch has never been published. */
  upstream: string | null;
  /**
   * Commits this branch has that its upstream does not, and `null` when Git
   * cannot count — the branch tracks, but no remote-tracking ref exists to
   * compare against (`@/types/git`). `null` is not zero anywhere below.
   */
  ahead: number | null;
  /** Commits the upstream has that this branch does not; `null` as above. */
  behind: number | null;
  /** Uncommitted entries in the working tree. */
  changedFileCount: number;
  /** False when the repository has no remote to push to at all. */
  hasRemote: boolean;
  pullRequest: GitPullRequestReadiness;
  /**
   * The repository's default branch, as `origin/HEAD` points at it. Null when
   * that ref is not set — a repository Git was never told the answer for.
   *
   * Two questions read it: the confirmation in §8 asks whether a push is about
   * to reach it, and the pull-request rung refuses to open one from the default
   * branch, which would have to be opened against itself.
   */
  defaultBranch: string | null;
  /**
   * The operation this worktree is stopped in the middle of, or null. Detected
   * by filesystem probe rather than by a Git command, so it rides on the panel
   * state at no cost to a normal read (§9).
   */
  conflictOperation: GitConflictOperation | null;
}

export type GitPrimaryActionLabelKey =
  | 'gitPanel.commit.button'
  | 'gitPanel.push.button'
  | 'gitPanel.push.publishButton'
  | 'gitPanel.pull.button'
  | 'gitPanel.pr.createButton';

export type GitPrimaryActionPendingLabelKey =
  | 'gitPanel.commit.buttonPending'
  | 'gitPanel.push.buttonPending'
  | 'gitPanel.push.publishButtonPending'
  | 'gitPanel.pull.buttonPending'
  | 'gitPanel.pr.createButtonPending';

export type GitPrimaryActionReasonKey =
  | 'gitPanel.conflict.mergeInProgress'
  | 'gitPanel.conflict.rebaseInProgress'
  | 'gitPanel.conflict.cherryPickInProgress'
  | 'gitPanel.primary.stateUnknown'
  | 'gitPanel.primary.detachedHead'
  | 'gitPanel.primary.noRemote'
  | 'gitPanel.push.nothingToPush'
  | 'gitPanel.pr.statusUnknown'
  | 'gitPanel.pr.unavailable'
  | 'gitPanel.pr.defaultBranch';

export interface GitPrimaryAction {
  kind: GitPrimaryActionKind;
  /** What the action route is asked to run. */
  action: 'commit' | 'push' | 'pull' | 'create_pr';
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
    pullRequest: readPullRequestReadiness(panel),
    defaultBranch: panel.defaultBranch,
    // A payload from before this field existed — one held in the client store
    // across a reload, one still in flight over the socket — is a worktree with
    // nothing in progress, which is the state that changes nothing.
    conflictOperation: panel.conflictOperation ?? null,
  };
}

/**
 * Three sources answer the same question, and the order between them is what
 * matters. `prStatus` is the pull request the panel actually shows — it arrives
 * from the live PR store, while `github.pullRequest` is null on every payload
 * the server sends. `prUnsupported` is the probe reporting that it cannot ask
 * GitHub at all — no `gh`, signed out, or a remote that is not GitHub — and
 * `github.reasonCode` is the server's own reading of the remote.
 */
function readPullRequestReadiness(panel: GitPanelData): GitPullRequestReadiness {
  if (panel.prUnsupported) return 'unsupported';
  if (panel.prStatusKnown === false) return 'unknown';
  if (panel.prStatus) return isCurrentTaskPr(panel.prStatus) ? 'exists' : 'none';
  if (panel.github.pullRequest) return 'exists';
  if (panel.github.reasonCode === 'no_pull_request') return 'none';
  if (panel.github.reasonCode === 'unknown' || panel.github.reasonCode === null) {
    return 'unknown';
  }
  return 'unsupported';
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

  // Above everything, including the dirty rung (§9). A stopped merge leaves a
  // tree full of conflicted files, so the rung below would claim it and offer a
  // commit Git refuses; and nothing further down the ladder can run either while
  // the sequencer holds the worktree. The way out is the abort in the menu.
  if (snapshot.conflictOperation) return conflictAction(snapshot.conflictOperation);

  // The dirty rung comes next, and it is the one rung a detached HEAD keeps:
  // committing without a branch is ordinary, pushing without one is not.
  if (snapshot.changedFileCount > 0) return commitAction(true, null);

  const blocked = describeRemoteObstacle(snapshot);

  // Above the ahead rung, and only ever with an upstream to pull from: a branch
  // that is behind cannot fast-forward its own push anyway, and one that has
  // never been published has nothing to be behind (§3).
  if (!blocked && snapshot.upstream && snapshot.behind !== null && snapshot.behind > 0) {
    return pullAction(snapshot.behind);
  }

  if (!snapshot.upstream) return publishAction(!blocked, blocked);
  if (blocked) return pushAction(false, blocked);
  // An uncounted branch gets the push rung rather than dropping through it. The
  // rung below says "there is nothing left to push", and this is precisely the
  // state where that cannot be established: pushing is idempotent, so offering
  // it costs a branch that was already in sync nothing, while skipping it would
  // hide commits that never reached the remote.
  if (snapshot.ahead === null || snapshot.ahead > 0) return pushAction(true, null);

  // Committed, pushed and tracking: the only step of delivery left is the pull
  // request (§3). A branch that already has one drops through to the push rung,
  // which says there is nothing to do — the panel reflects the pull request it
  // has rather than offering to open a second one.
  if (snapshot.pullRequest === 'exists') {
    return pushAction(false, 'gitPanel.push.nothingToPush');
  }

  // Nothing merges into itself. Only when the panel actually resolved a default
  // branch: a clone whose `origin/HEAD` never resolved reports null, and not
  // knowing is not a reason to withhold the action.
  if (snapshot.defaultBranch && snapshot.branch === snapshot.defaultBranch) {
    return createPullRequestAction('none', 'gitPanel.pr.defaultBranch');
  }

  return createPullRequestAction(snapshot.pullRequest);
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

/**
 * The commit path, held closed for as long as the worktree is in the middle of
 * something (§9). It keeps the Commit label rather than borrowing the abort's,
 * because what the button offers has not changed — it is the same rung, and the
 * reason beside it says what is standing in front of it and what to do about it.
 *
 * Resolving the conflict is still the editor's or the terminal's job. What the
 * panel guarantees is that the user is told, is offered nothing that cannot
 * work, and can always get out through the menu.
 */
const CONFLICT_REASON_KEY: Record<GitConflictOperation, GitPrimaryActionReasonKey> = {
  merge: 'gitPanel.conflict.mergeInProgress',
  rebase: 'gitPanel.conflict.rebaseInProgress',
  cherry_pick: 'gitPanel.conflict.cherryPickInProgress',
};

function conflictAction(operation: GitConflictOperation): GitPrimaryAction {
  return {
    kind: 'conflict',
    // Never dispatched — the rung is disabled and `runPrimaryAction` refuses a
    // disabled rung before it reads this. It names the path being blocked.
    action: 'commit',
    enabled: false,
    labelKey: 'gitPanel.commit.button',
    pendingLabelKey: 'gitPanel.commit.buttonPending',
    disabledReasonKey: CONFLICT_REASON_KEY[operation],
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

/**
 * The last rung. It renders on all three of its readiness values rather than
 * only the one it can run on, because the alternative — falling back to the
 * push rung — is the "nothing to do" frame ADR 0007 refuses for a state that is
 * merely not known yet, and it would leave a repository with no GitHub remote
 * with nothing to read but a push it does not need.
 */
function createPullRequestAction(
  readiness: GitPullRequestReadiness,
  /** What blocks the rung for a reason the readiness value cannot express. */
  blocked: GitPrimaryActionReasonKey | null = null,
): GitPrimaryAction {
  const disabledReasonKey: GitPrimaryActionReasonKey | null =
    blocked
      ?? (readiness === 'none'
        ? null
        : readiness === 'unknown'
          ? 'gitPanel.pr.statusUnknown'
          : 'gitPanel.pr.unavailable');

  return {
    kind: 'create_pr',
    action: 'create_pr',
    enabled: readiness === 'none' && !blocked,
    labelKey: 'gitPanel.pr.createButton',
    pendingLabelKey: 'gitPanel.pr.createButtonPending',
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
