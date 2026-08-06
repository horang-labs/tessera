import assert from 'node:assert/strict';
import test from 'node:test';
import {
  derivePrimaryGitAction,
  type GitStateSnapshot,
} from '@/lib/git/primary-git-action';
import { describeDefaultBranchPushConfirmation } from '@/lib/git/default-branch-confirmation';

/** Working directly on the repository's default branch, with commits to send. */
const ON_DEFAULT_BRANCH: GitStateSnapshot = {
  branch: 'main',
  upstream: 'origin/main',
  ahead: 2,
  changedFileCount: 0,
  hasRemote: true,
  defaultBranch: 'main',
};

test('pushing the default branch asks first, and names the branch', () => {
  const action = derivePrimaryGitAction(ON_DEFAULT_BRANCH);
  const confirmation = describeDefaultBranchPushConfirmation(
    action,
    ON_DEFAULT_BRANCH,
  );

  assert.notEqual(confirmation, null);
  assert.equal(confirmation?.branch, 'main');
});

test('a branch tracking the default branch is asked about under its own name', () => {
  const snapshot: GitStateSnapshot = {
    ...ON_DEFAULT_BRANCH,
    branch: 'hotfix',
    upstream: 'origin/main',
  };

  const confirmation = describeDefaultBranchPushConfirmation(
    derivePrimaryGitAction(snapshot),
    snapshot,
  );

  // What the push writes is what the upstream says, not what the local branch
  // happens to be called.
  assert.equal(confirmation?.branch, 'main');
});

test('the copy is assembled per action, so publishing does not read as pushing', () => {
  // A default branch the remote has never seen: same hazard, different verb.
  const unpublished: GitStateSnapshot = { ...ON_DEFAULT_BRANCH, upstream: null };
  const publishAction = derivePrimaryGitAction(unpublished);
  const publish = describeDefaultBranchPushConfirmation(publishAction, unpublished);
  const push = describeDefaultBranchPushConfirmation(
    derivePrimaryGitAction(ON_DEFAULT_BRANCH),
    ON_DEFAULT_BRANCH,
  );

  assert.equal(publishAction.kind, 'publish');
  assert.equal(publish?.branch, 'main');
  assert.notEqual(publish?.titleKey, push?.titleKey);
  assert.notEqual(publish?.bodyKey, push?.bodyKey);
  assert.notEqual(publish?.confirmLabelKey, push?.confirmLabelKey);
});

test('committing on the default branch is not what the confirmation guards', () => {
  const dirty: GitStateSnapshot = { ...ON_DEFAULT_BRANCH, changedFileCount: 3 };
  const action = derivePrimaryGitAction(dirty);

  assert.equal(action.kind, 'commit');
  // A commit stays local; §8 confirms the push that leaves the machine.
  assert.equal(describeDefaultBranchPushConfirmation(action, dirty), null);
});

test('a repository with no known default branch is never guessed at', () => {
  // `origin/HEAD` unset — Git itself does not know which branch is default.
  const unknownDefault: GitStateSnapshot = {
    ...ON_DEFAULT_BRANCH,
    defaultBranch: null,
  };

  assert.equal(
    describeDefaultBranchPushConfirmation(
      derivePrimaryGitAction(unknownDefault),
      unknownDefault,
    ),
    null,
  );
});

test('pushing any other branch runs without being interrupted', () => {
  const snapshot: GitStateSnapshot = {
    ...ON_DEFAULT_BRANCH,
    branch: 'feature/0807-t234',
    upstream: 'origin/feature/0807-t234',
  };

  assert.equal(
    describeDefaultBranchPushConfirmation(
      derivePrimaryGitAction(snapshot),
      snapshot,
    ),
    null,
  );
});

test('every locale can say what the confirmation asks, and names the branch', async () => {
  // `t()` renders an unknown key verbatim, so a missing translation reaches the
  // dialog as `gitPanel.push.defaultBranchConfirm.title`.
  const locales = Object.entries({
    en: (await import('@/lib/i18n/en')).en,
    ko: (await import('@/lib/i18n/ko')).ko,
    ja: (await import('@/lib/i18n/ja')).ja,
    zh: (await import('@/lib/i18n/zh')).zh,
  });

  const confirmations = [ON_DEFAULT_BRANCH, { ...ON_DEFAULT_BRANCH, upstream: null }]
    .map((snapshot) =>
      describeDefaultBranchPushConfirmation(
        derivePrimaryGitAction(snapshot),
        snapshot,
      ),
    );

  for (const [language, bundle] of locales) {
    for (const confirmation of confirmations) {
      assert.notEqual(confirmation, null);
      const read = (key: string): unknown =>
        key
          .split('.')
          .reduce<unknown>(
            (node, segment) => (node as Record<string, unknown> | undefined)?.[segment],
            bundle,
          );

      for (const key of [
        confirmation!.titleKey,
        confirmation!.bodyKey,
        confirmation!.confirmLabelKey,
      ]) {
        assert.equal(typeof read(key), 'string', `${language} is missing ${key}`);
      }

      // The branch is the point of the confirmation, so the two lines that
      // carry it must have somewhere to put it.
      for (const key of [confirmation!.bodyKey, confirmation!.confirmLabelKey]) {
        assert.ok(
          String(read(key)).includes('{{branch}}'),
          `${language} does not name the branch in ${key}`,
        );
      }
    }
  }
});
