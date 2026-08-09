/**
 * What the dropdown beside the primary button offers
 * (`docs/design/git-delivery.md` §4, ADR 0007).
 *
 * Derived independently from `derivePrimaryGitAction`, over the same snapshot.
 * The two answer different questions: the primary asks "what is the one thing to
 * do now", the menu asks "what are all the things, and why can each one not be
 * done". So an action stays listed even when the primary already offers it, and
 * even when it cannot run — it is disabled with a reason instead of vanishing,
 * which is what lets its position in the menu be learned.
 *
 * Labels are i18n keys for the same reason the ladder's are: this module answers
 * a question about repository state, and state has no language.
 */
import type { GitConflictOperation } from '@/types/git';
import type { GitStateSnapshot } from './primary-git-action';

/**
 * Every delivery action, in the order the menu always draws them. Nothing is
 * added or removed at runtime — a shape that moves under the cursor cannot be
 * learned, and §4 makes never changing shape the point of the menu.
 *
 * The abort of §9 is deliberately not one of them. It is not a step of delivery
 * but the way out of a worktree that is stuck part-way through one, and it
 * cannot be drawn at all without an operation to name it after: "Abort" on a
 * repository with nothing in progress is a word, not an action. It is appended
 * while a conflict is detected and nowhere else, which is what §2 means by
 * "only reachable during a conflict".
 */
export const GIT_MENU_ACTION_IDS = [
  'commit',
  'commit_push',
  'push',
  'pull',
  'create_pr',
  'open_source_control',
] as const;

/**
 * The fixed delivery actions. Conflict Recovery's escape is appended only while
 * an operation is active; the delivery entries themselves never move.
 */
export type GitDeliveryMenuActionId = (typeof GIT_MENU_ACTION_IDS)[number];

/** What the panel is asked to run in the menu's stable slot order. */
export type GitMenuActionId = GitDeliveryMenuActionId | 'abort';

/**
 * Which face an action is wearing. `publish` is `push` on a branch that has no
 * upstream yet — the same action under a different word (§2), which is why it is
 * a face rather than an entry of its own.
 */
export type GitMenuActionKind = GitMenuActionId | 'publish' | 'view_pr';

export type GitMenuActionLabelKey =
  | 'gitPanel.commit.button'
  | 'gitPanel.commit.menuButtonCount'
  | 'gitPanel.commitPush.button'
  | 'gitPanel.commitPush.buttonCount'
  | 'gitPanel.push.button'
  | 'gitPanel.push.buttonCount'
  | 'gitPanel.push.publishButton'
  | 'gitPanel.pull.menuButton'
  | 'gitPanel.pull.button'
  | 'gitPanel.pr.createButton'
  | 'gitPanel.pr.viewButton'
  | 'gitPanel.menu.openSourceControl'
  | 'gitPanel.conflict.abortMerge'
  | 'gitPanel.conflict.abortRebase'
  | 'gitPanel.conflict.abortCherryPick';

export type GitMenuActionReasonKey =
  | 'gitPanel.conflict.mergeInProgress'
  | 'gitPanel.conflict.rebaseInProgress'
  | 'gitPanel.conflict.cherryPickInProgress'
  | 'gitPanel.primary.stateUnknown'
  | 'gitPanel.primary.detachedHead'
  | 'gitPanel.primary.noRemote'
  | 'gitPanel.commit.nothingToCommit'
  | 'gitPanel.push.nothingToPush'
  | 'gitPanel.pull.nothingToPull'
  | 'gitPanel.pull.noUpstream'
  | 'gitPanel.pr.noUpstream'
  | 'gitPanel.pr.alreadyOpen'
  | 'gitPanel.pr.statusUnknown'
  | 'gitPanel.pr.unavailable'
  | 'gitPanel.pr.defaultBranch';

export interface GitMenuAction {
  id: GitMenuActionId;
  kind: GitMenuActionKind;
  enabled: boolean;
  labelKey: GitMenuActionLabelKey;
  /** What the label interpolates where the operation has a size (§4). */
  labelParams?: { count: number };
  /** Why it cannot run, in "why + what to do" form; null while it can. */
  disabledReasonKey: GitMenuActionReasonKey | null;
}

/** The label an unknown snapshot draws — the bare verb, with no size to claim. */
const RESTING_LABEL_KEY: Record<GitDeliveryMenuActionId, GitMenuActionLabelKey> = {
  commit: 'gitPanel.commit.button',
  commit_push: 'gitPanel.commitPush.button',
  push: 'gitPanel.push.button',
  pull: 'gitPanel.pull.menuButton',
  create_pr: 'gitPanel.pr.createButton',
  open_source_control: 'gitPanel.menu.openSourceControl',
};

export function deriveGitActionMenu(
  snapshot: GitStateSnapshot | null,
): GitMenuAction[] {
  const actions = GIT_MENU_ACTION_IDS.map((id) => describeMenuAction(id, snapshot));
  return snapshot?.conflictOperation
    ? [...actions, describeAbort(snapshot.conflictOperation)]
    : actions;
}

function describeMenuAction(
  id: GitDeliveryMenuActionId,
  snapshot: GitStateSnapshot | null,
): GitMenuAction {
  if (!snapshot) {
    return {
      id,
      kind: id,
      enabled: false,
      labelKey: RESTING_LABEL_KEY[id],
      disabledReasonKey: 'gitPanel.primary.stateUnknown',
    };
  }

  if (id === 'commit') return describeCommit(snapshot);
  if (id === 'push') return describePush(snapshot);
  if (id === 'pull') return describePull(snapshot);
  if (id === 'create_pr') return describeCreatePullRequest(snapshot);
  if (id === 'open_source_control') return describeOpenSourceControl();
  return describeCommitPush(snapshot);
}

function describeOpenSourceControl(): GitMenuAction {
  return {
    id: 'open_source_control',
    kind: 'open_source_control',
    enabled: true,
    labelKey: 'gitPanel.menu.openSourceControl',
    disabledReasonKey: null,
  };
}

/**
 * The one compound (§2), and the reason the menu exists beside a single-verb
 * button: committing and then pushing is the ordinary two-step day, and this
 * makes it one press for a user who wants it.
 *
 * It is not a rung of the ladder and never becomes the primary — ADR 0007 keeps
 * compounds in the menu, because a single verb either succeeded or failed while
 * a compound needs a phase contract to say which half died.
 */
function describeCommitPush(snapshot: GitStateSnapshot): GitMenuAction {
  const dirty = snapshot.changedFileCount > 0;
  // The commit half first: it is the half the user can do something about
  // without leaving the panel, so it is the more useful thing to be told.
  const blocked: GitMenuActionReasonKey | null = describeConflictObstacle(snapshot)
    ?? (!dirty
      ? 'gitPanel.commit.nothingToCommit'
      : describeRemoteObstacle(snapshot));

  return {
    id: 'commit_push',
    kind: 'commit_push',
    enabled: !blocked,
    labelKey: dirty ? 'gitPanel.commitPush.buttonCount' : 'gitPanel.commitPush.button',
    ...(dirty ? { labelParams: { count: snapshot.changedFileCount } } : {}),
    disabledReasonKey: blocked,
  };
}

/**
 * The one action a detached HEAD keeps: committing without a branch is ordinary,
 * everything downstream of it is not.
 */
function describeCommit(snapshot: GitStateSnapshot): GitMenuAction {
  const dirty = snapshot.changedFileCount > 0;
  const blocked = describeConflictObstacle(snapshot)
    ?? (dirty ? null : 'gitPanel.commit.nothingToCommit');

  return {
    id: 'commit',
    kind: 'commit',
    enabled: !blocked,
    labelKey: dirty ? 'gitPanel.commit.menuButtonCount' : 'gitPanel.commit.button',
    ...(dirty ? { labelParams: { count: snapshot.changedFileCount } } : {}),
    disabledReasonKey: blocked,
  };
}

/**
 * What an unfinished merge, rebase or cherry-pick says about the commit path
 * (§9). It comes before every other reason those two entries can give, because
 * it is the one the user has to clear first: a tree full of conflict markers is
 * not a change set, and Git refuses the commit whatever else is true of it.
 *
 * The commit path and the pull ask. Both are refused by Git outright while the
 * operation is unfinished, so both would otherwise be offered against §9. Push
 * does not ask: commits made before the conflict began still reach the remote,
 * so what it says for itself is unchanged.
 */
function describeConflictObstacle(
  snapshot: GitStateSnapshot,
): GitMenuActionReasonKey | null {
  return snapshot.conflictOperation
    ? CONFLICT_REASON_KEY[snapshot.conflictOperation]
    : null;
}

const CONFLICT_REASON_KEY: Record<GitConflictOperation, GitMenuActionReasonKey> = {
  merge: 'gitPanel.conflict.mergeInProgress',
  rebase: 'gitPanel.conflict.rebaseInProgress',
  cherry_pick: 'gitPanel.conflict.cherryPickInProgress',
};

const ABORT_LABEL_KEY: Record<GitConflictOperation, GitMenuActionLabelKey> = {
  merge: 'gitPanel.conflict.abortMerge',
  rebase: 'gitPanel.conflict.abortRebase',
  cherry_pick: 'gitPanel.conflict.abortCherryPick',
};

/**
 * The way out (§9). Always runnable, because it exists only when there is
 * something to abort — the detection that put it in the menu is the same one the
 * execution layer re-runs before it picks a command.
 *
 * It is labelled from the operation Git is actually in rather than from a
 * generic word: `git merge --abort` and `git rebase --abort` unwind different
 * things, and a button that did not say which is running is a button the user
 * has to guess at while their worktree is already broken.
 */
function describeAbort(operation: GitConflictOperation): GitMenuAction {
  return {
    id: 'abort',
    kind: 'abort',
    enabled: true,
    labelKey: ABORT_LABEL_KEY[operation],
    disabledReasonKey: null,
  };
}

/**
 * Push, wearing Publish Branch when the branch has never been published (§2).
 *
 * Publish is offered with nothing ahead, where Push is not: putting the branch
 * on the remote is the operation, and a branch with no commits of its own is
 * still a branch other people cannot see.
 */
function describePush(snapshot: GitStateSnapshot): GitMenuAction {
  const blocked = describeRemoteObstacle(snapshot);

  if (blocked) {
    return {
      id: 'push',
      kind: 'publish',
      enabled: false,
      labelKey: 'gitPanel.push.publishButton',
      disabledReasonKey: blocked,
    };
  }

  if (!snapshot.upstream) {
    return {
      id: 'push',
      kind: 'publish',
      enabled: true,
      labelKey: 'gitPanel.push.publishButton',
      disabledReasonKey: null,
    };
  }

  // A null count is "Git cannot compare", not "nothing to push": the branch
  // tracks something no remote-tracking ref mirrors. The entry stays enabled and
  // loses its count, because "Nothing to push" is a claim nothing here supports.
  const count = snapshot.ahead !== null && snapshot.ahead > 0 ? snapshot.ahead : null;
  const ahead = count !== null || snapshot.ahead === null;
  return {
    id: 'push',
    kind: 'push',
    enabled: ahead,
    labelKey: count !== null ? 'gitPanel.push.buttonCount' : 'gitPanel.push.button',
    ...(count !== null ? { labelParams: { count } } : {}),
    disabledReasonKey:
      ahead ? null : 'gitPanel.push.nothingToPush',
  };
}

/**
 * Pull. A branch with no upstream has nothing to be behind, and its reason says
 * what would give it one — "why + what to do" is the form §4 asks reasons to
 * take, and the alternative here ("Nothing to pull") would be true and useless.
 *
 * The conflict comes first, and above the count: Git refuses to pull into a tree
 * with unmerged files whatever the count says, so an entry that stayed enabled
 * would be one §9 promised not to offer — the user presses it, waits, and is
 * told afterwards what the menu already knew.
 */
function describePull(snapshot: GitStateSnapshot): GitMenuAction {
  // Null as in `describePush`, and the same answer: `git pull` fetches and
  // merges through the branch's configured upstream, so it works on exactly the
  // branch this cannot count, and "Nothing to pull" would be the panel asserting
  // a comparison it never made.
  const count = snapshot.behind !== null && snapshot.behind > 0 ? snapshot.behind : null;
  const behind = count !== null || snapshot.behind === null;
  const blocked = describeConflictObstacle(snapshot)
    ?? describeRemoteObstacle(snapshot)
    ?? (snapshot.upstream ? null : 'gitPanel.pull.noUpstream');

  return {
    id: 'pull',
    kind: 'pull',
    enabled: !blocked && behind,
    labelKey: count !== null ? 'gitPanel.pull.button' : 'gitPanel.pull.menuButton',
    ...(count !== null ? { labelParams: { count } } : {}),
    disabledReasonKey:
      blocked ?? (behind ? null : 'gitPanel.pull.nothingToPull'),
  };
}

/**
 * Create PR. The obstacles are checked in the order the user would have to clear
 * them: reach a remote, publish the branch, be somewhere other than the default
 * branch, and only then does what GitHub says about the branch matter.
 */
function describeCreatePullRequest(snapshot: GitStateSnapshot): GitMenuAction {
  if (snapshot.pullRequest === 'exists') {
    return {
      id: 'create_pr',
      kind: 'view_pr',
      enabled: true,
      labelKey: 'gitPanel.pr.viewButton',
      disabledReasonKey: null,
    };
  }

  const blocked = describeRemoteObstacle(snapshot)
    ?? (snapshot.upstream ? null : 'gitPanel.pr.noUpstream')
    ?? (snapshot.defaultBranch && snapshot.branch === snapshot.defaultBranch
      ? 'gitPanel.pr.defaultBranch'
      : null)
    ?? readinessObstacle(snapshot.pullRequest);

  return {
    id: 'create_pr',
    kind: 'create_pr',
    enabled: !blocked,
    labelKey: 'gitPanel.pr.createButton',
    disabledReasonKey: blocked,
  };
}

/** What GitHub's answer — or the absence of one — says about opening a second. */
function readinessObstacle(
  readiness: GitStateSnapshot['pullRequest'],
): GitMenuActionReasonKey | null {
  if (readiness === 'none') return null;
  // The panel reflects the pull request it has rather than offering to open a
  // second one about the same branch.
  if (readiness === 'exists') return 'gitPanel.pr.alreadyOpen';
  if (readiness === 'unknown') return 'gitPanel.pr.statusUnknown';
  return 'gitPanel.pr.unavailable';
}

/**
 * What stops this branch reaching a remote at all, before any commit is counted.
 * The ladder asks the same question of the same snapshot; the two are separate
 * derivations by design (§4), so they answer it separately.
 */
function describeRemoteObstacle(
  snapshot: GitStateSnapshot,
): GitMenuActionReasonKey | null {
  if (!snapshot.branch) return 'gitPanel.primary.detachedHead';
  if (!snapshot.hasRemote) return 'gitPanel.primary.noRemote';
  return null;
}
