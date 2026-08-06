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
import type { GitPrimaryAction, GitStateSnapshot } from './primary-git-action';

export type GitDefaultBranchConfirmTitleKey =
  | 'gitPanel.push.defaultBranchConfirm.title'
  | 'gitPanel.push.defaultBranchConfirm.publishTitle';

export type GitDefaultBranchConfirmBodyKey =
  | 'gitPanel.push.defaultBranchConfirm.body'
  | 'gitPanel.push.defaultBranchConfirm.publishBody';

export type GitDefaultBranchConfirmLabelKey =
  | 'gitPanel.push.defaultBranchConfirm.confirm'
  | 'gitPanel.push.defaultBranchConfirm.publishConfirm';

export interface GitDefaultBranchConfirmation {
  /** The branch the push would write to, which the copy names. */
  branch: string;
  titleKey: GitDefaultBranchConfirmTitleKey;
  bodyKey: GitDefaultBranchConfirmBodyKey;
  confirmLabelKey: GitDefaultBranchConfirmLabelKey;
}

/**
 * Null means run the action — there is nothing to ask about. There is no third
 * answer: creating a feature branch and running the action there needs a
 * branch-creation action and a client-supplied ref, both out of v1 scope (§8).
 */
export function describeDefaultBranchPushConfirmation(
  action: GitPrimaryAction,
  snapshot: GitStateSnapshot | null,
): GitDefaultBranchConfirmation | null {
  if (!snapshot) return null;
  if (action.action !== 'push') return null;

  const target = resolvePushTargetBranch(snapshot);
  // `null` default branch is a repository Git was never told the answer for,
  // and `target` is null on a detached HEAD. Neither is a match for the other.
  if (!target || target !== snapshot.defaultBranch) return null;

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

/**
 * Which remote branch this push would write, which is not always the branch the
 * user is standing on: an upstream is what `git push` follows, and the local
 * name only decides the answer when there is no upstream to follow — the first
 * push, which creates the remote branch under the local name.
 *
 * Null on a detached HEAD, where there is nothing to push and no name to say.
 */
function resolvePushTargetBranch(snapshot: GitStateSnapshot): string | null {
  if (!snapshot.upstream) return snapshot.branch;

  // `<remote>/<branch>`, and the branch half can hold slashes of its own.
  const separator = snapshot.upstream.indexOf('/');
  if (separator < 0) return snapshot.upstream;
  return snapshot.upstream.slice(separator + 1) || null;
}
