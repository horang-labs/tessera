import assert from 'node:assert/strict';
import test from 'node:test';
import {
  derivePrimaryGitAction,
  type GitStateSnapshot,
} from '@/lib/git/primary-git-action';

/** A branch that is committed, pushed and tracking — the quiet middle of the ladder. */
const SYNCED: GitStateSnapshot = {
  branch: 'feature/0807-t233',
  upstream: 'origin/feature/0807-t233',
  ahead: 0,
  changedFileCount: 0,
  hasRemote: true,
};

test('state that is not known yet holds a disabled Commit frame', () => {
  const action = derivePrimaryGitAction(null);

  assert.equal(action.kind, 'commit');
  assert.equal(action.enabled, false);
  // Folding unknown into "nothing to do" is what makes the button flash through
  // an action the user did not press on every session switch (ADR 0007).
  assert.notEqual(action.disabledReasonKey, null);
});

test('uncommitted changes make the primary action Commit', () => {
  const action = derivePrimaryGitAction({ ...SYNCED, changedFileCount: 3 });

  assert.equal(action.kind, 'commit');
  assert.equal(action.enabled, true);
});

test('a clean branch that is ahead offers Push, without the user choosing it', () => {
  const action = derivePrimaryGitAction({ ...SYNCED, ahead: 2 });

  assert.equal(action.kind, 'push');
  assert.equal(action.action, 'push');
  assert.equal(action.enabled, true);
  assert.equal(action.labelKey, 'gitPanel.push.button');
});

test('a branch with no upstream is offered as Publish Branch, not as Push', () => {
  const action = derivePrimaryGitAction({
    ...SYNCED,
    upstream: null,
    ahead: 0,
  });

  assert.equal(action.kind, 'publish');
  // The same verb underneath — the label is what tells the user a remote branch
  // is about to exist (§2).
  assert.equal(action.action, 'push');
  assert.equal(action.enabled, true);
  assert.equal(action.labelKey, 'gitPanel.push.publishButton');
});

test('a clean branch with nothing ahead offers a Push it says is empty', () => {
  const action = derivePrimaryGitAction(SYNCED);

  assert.equal(action.kind, 'push');
  assert.equal(action.enabled, false);
  assert.equal(action.disabledReasonKey, 'gitPanel.push.nothingToPush');
});

test('a repository with no remote cannot publish, and says so', () => {
  const action = derivePrimaryGitAction({
    ...SYNCED,
    upstream: null,
    hasRemote: false,
  });

  assert.equal(action.kind, 'publish');
  assert.equal(action.enabled, false);
  assert.equal(action.disabledReasonKey, 'gitPanel.primary.noRemote');
});

test('a detached HEAD is not offered a push it has no branch for', () => {
  const detached = derivePrimaryGitAction({ ...SYNCED, branch: null, ahead: 2 });

  assert.equal(detached.enabled, false);
  assert.equal(detached.disabledReasonKey, 'gitPanel.primary.detachedHead');
  // Committing a detached HEAD is a normal thing to do, so that rung stands.
  assert.equal(
    derivePrimaryGitAction({ ...SYNCED, branch: null, changedFileCount: 1 }).enabled,
    true,
  );
});

test('committing rotates the same button from Commit to Push', () => {
  const dirty = derivePrimaryGitAction({ ...SYNCED, changedFileCount: 1 });
  // What the panel reads back after the commit lands: the tree is clean and the
  // branch is one commit ahead.
  const committed = derivePrimaryGitAction({ ...SYNCED, ahead: 1 });

  assert.equal(dirty.kind, 'commit');
  assert.equal(committed.kind, 'push');
});

test('every label and reason the ladder can name resolves in every locale', async () => {
  // `t()` accepts a key that does not exist and renders it verbatim, so a
  // missing translation shows up on the button as `gitPanel.push.button`.
  const locales = Object.entries({
    en: (await import('@/lib/i18n/en')).en,
    ko: (await import('@/lib/i18n/ko')).ko,
    ja: (await import('@/lib/i18n/ja')).ja,
    zh: (await import('@/lib/i18n/zh')).zh,
  });

  const snapshots: Array<GitStateSnapshot | null> = [
    null,
    { ...SYNCED, changedFileCount: 2 },
    { ...SYNCED, ahead: 3 },
    SYNCED,
    { ...SYNCED, upstream: null },
    { ...SYNCED, upstream: null, hasRemote: false },
    { ...SYNCED, branch: null, ahead: 1 },
  ];

  const keys = new Set<string>();
  for (const snapshot of snapshots) {
    const action = derivePrimaryGitAction(snapshot);
    keys.add(action.labelKey);
    keys.add(action.pendingLabelKey);
    if (action.disabledReasonKey) keys.add(action.disabledReasonKey);
  }

  for (const [language, bundle] of locales) {
    for (const key of keys) {
      const value = key
        .split('.')
        .reduce<unknown>(
          (node, segment) => (node as Record<string, unknown> | undefined)?.[segment],
          bundle,
        );
      assert.equal(typeof value, 'string', `${language} is missing ${key}`);
    }
  }
});
