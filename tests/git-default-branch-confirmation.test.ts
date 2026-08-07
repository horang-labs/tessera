import assert from 'node:assert/strict';
import test from 'node:test';
import {
  derivePrimaryGitAction,
  type GitStateSnapshot,
} from '@/lib/git/primary-git-action';
import { describeDefaultBranchPushConfirmation } from '@/lib/git/default-branch-confirmation';
import { deriveGitActionMenu } from '@/lib/git/git-action-menu';

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

test('a worktree branched off the default branch still pushes uninterrupted', () => {
  // What `git worktree add -b feature/x <path> origin/main` leaves behind: the
  // branch tracks `origin/main` under its own name. This is how every Tessera
  // worktree starts, so reading the push target off the upstream would stop
  // every ordinary push to ask about `main` — and name a branch nothing
  // writes, since `push.default=simple` refuses a bare push when the two names
  // disagree.
  const snapshot: GitStateSnapshot = {
    ...ON_DEFAULT_BRANCH,
    branch: 'feature/0807-t234',
    upstream: 'origin/main',
  };

  assert.equal(
    describeDefaultBranchPushConfirmation(
      derivePrimaryGitAction(snapshot),
      snapshot,
    ),
    null,
  );
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

test('Commit & Push at the default branch is asked about, in its own words', () => {
  // The dropdown's one compound pushes too, so it must clear the same gate the
  // primary button clears — reaching `main` by way of a menu entry rather than
  // a button is still reaching `main` (§8).
  const dirty: GitStateSnapshot = { ...ON_DEFAULT_BRANCH, changedFileCount: 3 };
  const commitPush = deriveGitActionMenu(dirty).find(
    (action) => action.id === 'commit_push',
  )!;

  const confirmation = describeDefaultBranchPushConfirmation(commitPush, dirty);

  assert.equal(confirmation?.branch, 'main');
  // Its own copy: what it is about to do is commit *and* push, and §8 assembles
  // the copy per action rather than reusing one string.
  assert.equal(
    confirmation?.titleKey,
    'gitPanel.push.defaultBranchConfirm.commitPushTitle',
  );
});

test('a menu action that does not push is never asked about', () => {
  const dirty: GitStateSnapshot = { ...ON_DEFAULT_BRANCH, changedFileCount: 3 };

  for (const id of ['commit', 'pull', 'create_pr']) {
    const action = deriveGitActionMenu(dirty).find((item) => item.id === id)!;
    assert.equal(
      describeDefaultBranchPushConfirmation(action, dirty),
      null,
      `${id} raised a push confirmation`,
    );
  }
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

  const dirty: GitStateSnapshot = { ...ON_DEFAULT_BRANCH, changedFileCount: 3 };
  const confirmations = [
    ...[ON_DEFAULT_BRANCH, { ...ON_DEFAULT_BRANCH, upstream: null }].map(
      (snapshot) =>
        describeDefaultBranchPushConfirmation(
          derivePrimaryGitAction(snapshot),
          snapshot,
        ),
    ),
    // The menu's compound asks the same question in its own words, so its copy
    // has to exist everywhere the button's does.
    describeDefaultBranchPushConfirmation(
      deriveGitActionMenu(dirty).find((action) => action.id === 'commit_push')!,
      dirty,
    ),
  ];

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
