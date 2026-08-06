/**
 * The confirmation that stands between a push and the repository's default
 * branch (`docs/design/git-delivery.md` §8).
 *
 * It matters most on a base workspace, where the user is working directly on
 * the default branch and the primary button offers Push the same way it does
 * anywhere else — one press away from putting commits on `main` by reflex.
 *
 * A pure function beside the ladder, and for the same reason: what the panel
 * has to ask, and what it says while asking, is a question about repository
 * state rather than about a component. Copy is per action rather than one fixed
 * string (§8), so the answer carries keys instead of words.
 */
import type { GitMenuAction } from './git-action-menu';
import type { GitPrimaryAction, GitStateSnapshot } from './primary-git-action';

export type GitDefaultBranchConfirmTitleKey =
  | 'gitPanel.push.defaultBranchConfirm.title'
  | 'gitPanel.push.defaultBranchConfirm.publishTitle'
  | 'gitPanel.push.defaultBranchConfirm.commitPushTitle';

export type GitDefaultBranchConfirmBodyKey =
  | 'gitPanel.push.defaultBranchConfirm.body'
  | 'gitPanel.push.defaultBranchConfirm.publishBody'
  | 'gitPanel.push.defaultBranchConfirm.commitPushBody';

export type GitDefaultBranchConfirmLabelKey =
  | 'gitPanel.push.defaultBranchConfirm.confirm'
  | 'gitPanel.push.defaultBranchConfirm.publishConfirm'
  | 'gitPanel.push.defaultBranchConfirm.commitPushConfirm';

export interface GitDefaultBranchConfirmation {
  /**
   * The branch the push would write to, which the copy names — the branch the
   * user is standing on.
   *
   * Not the upstream's branch, even though `git push` follows the upstream: a
   * Tessera worktree branched from `origin/dev` tracks `origin/dev` under a
   * feature-branch name, and reading the target off the upstream there would
   * stop every ordinary push to ask about `dev`. It would also be naming a
   * branch nothing writes — `push.default=simple`, Git's default, refuses a
   * bare `git push` outright when the two names disagree.
   */
  branch: string;
  titleKey: GitDefaultBranchConfirmTitleKey;
  bodyKey: GitDefaultBranchConfirmBodyKey;
  confirmLabelKey: GitDefaultBranchConfirmLabelKey;
}

/**
 * Anything that can reach the remote — the button's push, and the menu's Commit
 * & Push, which pushes at the end of it. Reaching the default branch by way of a
 * menu entry rather than a button is still reaching it.
 */
type GitDefaultBranchPushCandidate =
  | Pick<GitPrimaryAction, 'action' | 'kind'>
  | Pick<GitMenuAction, 'id' | 'kind'>;

/**
 * Null means run the action — there is nothing to ask about. There is no third
 * answer: creating a feature branch and running the action there needs a
 * branch-creation action and a client-supplied ref, both out of v1 scope (§8).
 */
export function describeDefaultBranchPushConfirmation(
  action: GitDefaultBranchPushCandidate,
  snapshot: GitStateSnapshot | null,
): GitDefaultBranchConfirmation | null {
  if (!snapshot) return null;
  if (action.kind !== 'push' && action.kind !== 'publish' && action.kind !== 'commit_push') {
    return null;
  }

  // `null` branch is a detached HEAD, where there is nothing to push and no
  // name to say; `null` default branch is a repository Git was never told the
  // answer for. Neither is a match for the other.
  const target = snapshot.branch;
  if (!target || target !== snapshot.defaultBranch) return null;

  // Copy per action rather than one fixed string (§8): each of the three says
  // what it is actually about to do to the branch it names.
  if (action.kind === 'commit_push') {
    return {
      branch: target,
      titleKey: 'gitPanel.push.defaultBranchConfirm.commitPushTitle',
      bodyKey: 'gitPanel.push.defaultBranchConfirm.commitPushBody',
      confirmLabelKey: 'gitPanel.push.defaultBranchConfirm.commitPushConfirm',
    };
  }

  return action.kind === 'publish'
    ? {
      branch: target,
      titleKey: 'gitPanel.push.defaultBranchConfirm.publishTitle',
      bodyKey: 'gitPanel.push.defaultBranchConfirm.publishBody',
      confirmLabelKey: 'gitPanel.push.defaultBranchConfirm.publishConfirm',
    }
    : {
      branch: target,
      titleKey: 'gitPanel.push.defaultBranchConfirm.title',
      bodyKey: 'gitPanel.push.defaultBranchConfirm.body',
      confirmLabelKey: 'gitPanel.push.defaultBranchConfirm.confirm',
    };
}
