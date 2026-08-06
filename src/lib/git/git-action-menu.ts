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
import type { GitStateSnapshot } from './primary-git-action';

/**
 * Every action, in the order the menu always draws them: the order of delivery.
 * Nothing is added or removed at runtime — a shape that moves under the cursor
 * cannot be learned, and §4 makes never changing shape the point of the menu.
 */
export const GIT_MENU_ACTION_IDS = [
  'commit',
  'commit_push',
  'push',
  'pull',
  'create_pr',
] as const;

/** What the panel is asked to run, and the stable name the menu remembers. */
export type GitMenuActionId = (typeof GIT_MENU_ACTION_IDS)[number];

/**
 * Which face an action is wearing. `publish` is `push` on a branch that has no
 * upstream yet — the same action under a different word (§2), which is why it is
 * a face rather than an entry of its own.
 */
export type GitMenuActionKind = GitMenuActionId | 'publish';

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
  | 'gitPanel.pr.createButton';

export type GitMenuActionReasonKey =
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
const RESTING_LABEL_KEY: Record<GitMenuActionId, GitMenuActionLabelKey> = {
  commit: 'gitPanel.commit.button',
  commit_push: 'gitPanel.commitPush.button',
  push: 'gitPanel.push.button',
  pull: 'gitPanel.pull.menuButton',
  create_pr: 'gitPanel.pr.createButton',
};

export interface GitActionMenuOptions {
  /**
   * The action chosen last time, lifted to the top of the menu (§4), so a
   * workflow repeated all day is not re-selected from the middle of the list
   * every time.
   *
   * Position only. A promoted action that cannot run right now stays promoted
   * and stays disabled — sinking it back would be the menu changing shape,
   * which is exactly what §4 rules out.
   */
  promoted?: GitMenuActionId | null;
}

export function deriveGitActionMenu(
  snapshot: GitStateSnapshot | null,
  options: GitActionMenuOptions = {},
): GitMenuAction[] {
  const actions = GIT_MENU_ACTION_IDS.map((id) => describeMenuAction(id, snapshot));
  const promoted = actions.findIndex((action) => action.id === options.promoted);
  // -1 covers both "nothing remembered" and a name this version no longer has —
  // an unreadable memory is not a reason to draw a different menu.
  if (promoted <= 0) return actions;

  return [actions[promoted]!, ...actions.filter((_, index) => index !== promoted)];
}

function describeMenuAction(
  id: GitMenuActionId,
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
  return describeCommitPush(snapshot);
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
  const blocked: GitMenuActionReasonKey | null = !dirty
    ? 'gitPanel.commit.nothingToCommit'
    : describeRemoteObstacle(snapshot);

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

  return {
    id: 'commit',
    kind: 'commit',
    enabled: dirty,
    labelKey: dirty ? 'gitPanel.commit.menuButtonCount' : 'gitPanel.commit.button',
    ...(dirty ? { labelParams: { count: snapshot.changedFileCount } } : {}),
    disabledReasonKey: dirty ? null : 'gitPanel.commit.nothingToCommit',
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

  if (!snapshot.upstream) {
    return {
      id: 'push',
      kind: 'publish',
      enabled: !blocked,
      labelKey: 'gitPanel.push.publishButton',
      disabledReasonKey: blocked,
    };
  }

  const ahead = snapshot.ahead > 0;
  return {
    id: 'push',
    kind: 'push',
    enabled: !blocked && ahead,
    labelKey: ahead ? 'gitPanel.push.buttonCount' : 'gitPanel.push.button',
    ...(ahead ? { labelParams: { count: snapshot.ahead } } : {}),
    disabledReasonKey:
      blocked ?? (ahead ? null : 'gitPanel.push.nothingToPush'),
  };
}

/**
 * Pull. A branch with no upstream has nothing to be behind, and its reason says
 * what would give it one — "why + what to do" is the form §4 asks reasons to
 * take, and the alternative here ("Nothing to pull") would be true and useless.
 */
function describePull(snapshot: GitStateSnapshot): GitMenuAction {
  const behind = snapshot.behind > 0;
  const blocked = describeRemoteObstacle(snapshot)
    ?? (snapshot.upstream ? null : 'gitPanel.pull.noUpstream');

  return {
    id: 'pull',
    kind: 'pull',
    enabled: !blocked && behind,
    labelKey: behind ? 'gitPanel.pull.button' : 'gitPanel.pull.menuButton',
    ...(behind ? { labelParams: { count: snapshot.behind } } : {}),
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
