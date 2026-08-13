import assert from 'node:assert/strict';
import test from 'node:test';
import {
  deriveGitActionMenu,
  GIT_MENU_ACTION_IDS,
} from '@/lib/git/git-action-menu';
import type { GitStateSnapshot } from '@/lib/git/primary-git-action';

/**
 * A branch that is committed, pushed, tracking and already has a pull request —
 * the far end of the ladder, where delivery is finished. The same starting point
 * the primary-action tests use, so the two derivations can be read side by side.
 */
const SYNCED: GitStateSnapshot = {
  branch: 'feature/0807-t237',
  upstream: 'origin/feature/0807-t237',
  ahead: 0,
  behind: 0,
  changedFileCount: 0,
  hasRemote: true,
  pullRequest: 'exists',
  defaultBranch: 'dev',
  conflictOperation: null,
};

/** The same branch, stopped in the middle of a merge it could not finish. */
const CONFLICTED: GitStateSnapshot = {
  ...SYNCED,
  changedFileCount: 3,
  conflictOperation: 'merge',
};

/** The one entry with this id — the menu never lists an action twice. */
function entry(
  snapshot: GitStateSnapshot | null,
  id: string,
): ReturnType<typeof deriveGitActionMenu>[number] {
  const matches = deriveGitActionMenu(snapshot).filter((item) => item.id === id);
  assert.equal(matches.length, 1, `${id} appears ${matches.length} times`);
  return matches[0]!;
}

test('Commit carries the size of the change set, and says why it cannot run', () => {
  const dirty = entry({ ...SYNCED, changedFileCount: 4 }, 'commit');
  assert.equal(dirty.enabled, true);
  assert.deepEqual(dirty.labelParams, { count: 4 });

  const clean = entry(SYNCED, 'commit');
  assert.equal(clean.enabled, false);
  assert.equal(clean.disabledReasonKey, 'gitPanel.commit.nothingToCommit');
  // A bare verb rather than "Commit (0)": the count is there to say how big the
  // operation is, and there is no operation.
  assert.equal(clean.labelParams, undefined);
});

test('Push counts the commits it would send, and wears Publish without an upstream', () => {
  const ahead = entry({ ...SYNCED, ahead: 2 }, 'push');
  assert.equal(ahead.kind, 'push');
  assert.equal(ahead.enabled, true);
  assert.deepEqual(ahead.labelParams, { count: 2 });

  const nothing = entry(SYNCED, 'push');
  assert.equal(nothing.enabled, false);
  assert.equal(nothing.disabledReasonKey, 'gitPanel.push.nothingToPush');

  // Same action, different word (§2) — and it is offered with no commits ahead,
  // because publishing the branch is the point rather than the commits on it.
  const unpublished = entry({ ...SYNCED, upstream: null, ahead: 0 }, 'push');
  assert.equal(unpublished.id, 'push');
  assert.equal(unpublished.kind, 'publish');
  assert.equal(unpublished.enabled, true);
  assert.equal(unpublished.labelKey, 'gitPanel.push.publishButton');
});

test('diverged and uncounted branches do not expose speculative remote actions', () => {
  const diverged = { ...SYNCED, ahead: 2, behind: 1, pullRequest: 'none' as const };
  const push = entry(diverged, 'push');
  assert.equal(push.enabled, false);
  assert.equal(push.disabledReasonKey, 'gitPanel.push.pullFirst');

  const divergedPr = entry(diverged, 'create_pr');
  assert.equal(divergedPr.enabled, false);
  assert.equal(divergedPr.disabledReasonKey, 'gitPanel.pr.pullFirst');

  const aheadPr = entry({ ...SYNCED, ahead: 2, pullRequest: 'none' }, 'create_pr');
  assert.equal(aheadPr.enabled, false);
  assert.equal(aheadPr.disabledReasonKey, 'gitPanel.pr.pushFirst');

  for (const id of ['push', 'pull', 'create_pr']) {
    const unknown = entry(
      { ...SYNCED, ahead: null, behind: null, pullRequest: 'none' },
      id,
    );
    assert.equal(unknown.enabled, false, `${id} is enabled without comparison state`);
    assert.equal(unknown.disabledReasonKey, 'gitPanel.primary.stateUnknown');
  }
});

test('nothing reaches a remote from a detached HEAD or a repository without one', () => {
  const detached = entry({ ...SYNCED, branch: null, ahead: 2 }, 'push');
  assert.equal(detached.kind, 'publish');
  assert.equal(detached.enabled, false);
  assert.equal(detached.disabledReasonKey, 'gitPanel.primary.detachedHead');

  const remoteless = entry(
    { ...SYNCED, hasRemote: false, upstream: null, ahead: 2 },
    'push',
  );
  assert.equal(remoteless.enabled, false);
  assert.equal(remoteless.kind, 'publish');
  assert.equal(remoteless.disabledReasonKey, 'gitPanel.primary.noRemote');
});

test('Pull counts what is waiting, and an unpublished branch is told what to do first', () => {
  const behind = entry({ ...SYNCED, behind: 3 }, 'pull');
  assert.equal(behind.enabled, true);
  assert.deepEqual(behind.labelParams, { count: 3 });

  const caughtUp = entry(SYNCED, 'pull');
  assert.equal(caughtUp.enabled, false);
  assert.equal(caughtUp.disabledReasonKey, 'gitPanel.pull.nothingToPull');

  // §4's example of a reason that says what would make the action available,
  // rather than only that it is unavailable.
  const unpublished = entry({ ...SYNCED, upstream: null, behind: 0 }, 'pull');
  assert.equal(unpublished.enabled, false);
  assert.equal(unpublished.disabledReasonKey, 'gitPanel.pull.noUpstream');
});

test('Create PR names each of the things that can stand in its way', () => {
  const ready = entry({ ...SYNCED, pullRequest: 'none' }, 'create_pr');
  assert.equal(ready.enabled, true);
  assert.equal(ready.disabledReasonKey, null);

  const already = entry(SYNCED, 'create_pr');
  assert.equal(already.kind, 'view_pr');
  assert.equal(already.enabled, true);
  assert.equal(already.labelKey, 'gitPanel.pr.viewButton');
  assert.equal(already.disabledReasonKey, null);

  const unpublished = entry(
    { ...SYNCED, upstream: null, pullRequest: 'none' },
    'create_pr',
  );
  assert.equal(unpublished.enabled, false);
  assert.equal(unpublished.disabledReasonKey, 'gitPanel.pr.noUpstream');

  // Nothing merges into itself.
  const onDefault = entry(
    { ...SYNCED, branch: 'dev', upstream: 'origin/dev', pullRequest: 'none' },
    'create_pr',
  );
  assert.equal(onDefault.enabled, false);
  assert.equal(onDefault.disabledReasonKey, 'gitPanel.pr.defaultBranch');

  // Still being asked over the network is not the same as "there is none", and
  // an enabled Create PR under the cursor on every session switch is what
  // telling the two apart avoids (ADR 0007).
  const asking = entry({ ...SYNCED, pullRequest: 'unknown' }, 'create_pr');
  assert.equal(asking.enabled, false);
  assert.equal(asking.disabledReasonKey, 'gitPanel.pr.statusUnknown');

  const noGitHub = entry({ ...SYNCED, pullRequest: 'unsupported' }, 'create_pr');
  assert.equal(noGitHub.enabled, false);
  assert.equal(noGitHub.disabledReasonKey, 'gitPanel.pr.unavailable');
});

test('Commit & Push needs both halves, and names whichever one is missing', () => {
  const ready = entry({ ...SYNCED, changedFileCount: 2 }, 'commit_push');
  assert.equal(ready.enabled, true);
  assert.deepEqual(ready.labelParams, { count: 2 });

  // The commit half comes first, because it is the half the user can act on
  // without leaving the panel.
  const clean = entry(SYNCED, 'commit_push');
  assert.equal(clean.enabled, false);
  assert.equal(clean.disabledReasonKey, 'gitPanel.commit.nothingToCommit');

  const detached = entry(
    { ...SYNCED, changedFileCount: 2, branch: null },
    'commit_push',
  );
  assert.equal(detached.enabled, false);
  assert.equal(detached.disabledReasonKey, 'gitPanel.primary.detachedHead');

  // An unpublished branch is no obstacle: the push half publishes it, which is
  // the same action under a different word (§2).
  const unpublished = entry(
    { ...SYNCED, changedFileCount: 2, upstream: null, ahead: 0 },
    'commit_push',
  );
  assert.equal(unpublished.enabled, true);
});

test('a conflict closes the commit path in the menu as well as on the button', () => {
  // The dirty tree a stopped merge leaves would otherwise read as two runnable
  // entries; both of them end in a commit Git refuses (§9).
  const commit = entry(CONFLICTED, 'commit');
  assert.equal(commit.enabled, false);
  assert.equal(commit.disabledReasonKey, 'gitPanel.conflict.mergeInProgress');

  const commitPush = entry(CONFLICTED, 'commit_push');
  assert.equal(commitPush.enabled, false);
  assert.equal(commitPush.disabledReasonKey, 'gitPanel.conflict.mergeInProgress');
});

test('a conflict closes the pull, while divergence independently closes push', () => {
  // The state an unfinished merge actually leaves: the remote is ahead, so the
  // entry carried a count and read as runnable, and Git refused it after the
  // press with "Pulling is not possible because you have unmerged files".
  const behind: GitStateSnapshot = { ...CONFLICTED, behind: 1 };

  const pull = entry(behind, 'pull');
  assert.equal(pull.enabled, false);
  assert.equal(pull.disabledReasonKey, 'gitPanel.conflict.mergeInProgress');

  // The conflict itself does not close Push, but the known remote commits do:
  // this push would be rejected as non-fast-forward even after the conflict.
  const push = entry({ ...behind, ahead: 2 }, 'push');
  assert.equal(push.enabled, false);
  assert.equal(push.disabledReasonKey, 'gitPanel.push.pullFirst');
});

test('the way out is in the menu, labelled from the operation that was detected', () => {
  const merge = entry(CONFLICTED, 'abort');
  assert.equal(merge.enabled, true);
  assert.equal(merge.labelKey, 'gitPanel.conflict.abortMerge');

  const rebase = entry({ ...CONFLICTED, conflictOperation: 'rebase' }, 'abort');
  assert.equal(rebase.labelKey, 'gitPanel.conflict.abortRebase');

  const cherryPick = entry(
    { ...CONFLICTED, conflictOperation: 'cherry_pick' },
    'abort',
  );
  assert.equal(cherryPick.labelKey, 'gitPanel.conflict.abortCherryPick');
});

test('the abort is offered only while there is something to abort', () => {
  // It cannot be listed on a normal rung the way the delivery actions are:
  // there is no operation to name it after, so there is no label to draw. §2
  // makes it reachable during a conflict and nowhere else.
  for (const snapshot of [null, SYNCED, { ...SYNCED, changedFileCount: 2 }]) {
    assert.equal(
      deriveGitActionMenu(snapshot).some((action) => action.id === 'abort'),
      false,
    );
  }
});

test('the abort sits after the delivery actions, which keep their order', () => {
  const ids = deriveGitActionMenu(CONFLICTED).map((action) => action.id);

  assert.deepEqual(ids, [...GIT_MENU_ACTION_IDS, 'abort']);
});

/** Enough snapshots to reach every label and every reason the menu can name. */
const COVERING_SNAPSHOTS: (GitStateSnapshot | null)[] = [
  null,
  SYNCED,
  { ...SYNCED, changedFileCount: 2 },
  { ...SYNCED, ahead: 3 },
  { ...SYNCED, behind: 4 },
  { ...SYNCED, upstream: null },
  { ...SYNCED, branch: null },
  { ...SYNCED, hasRemote: false, upstream: null },
  { ...SYNCED, pullRequest: 'none' },
  { ...SYNCED, pullRequest: 'unknown' },
  { ...SYNCED, pullRequest: 'unsupported' },
  { ...SYNCED, branch: 'dev', upstream: 'origin/dev', pullRequest: 'none' },
  CONFLICTED,
  { ...CONFLICTED, conflictOperation: 'rebase' },
  { ...CONFLICTED, conflictOperation: 'cherry_pick' },
];

test('every label and reason the menu can name resolves in every locale', async () => {
  // `t()` renders a key it does not have verbatim, so a missing translation
  // reaches the menu as `gitPanel.commitPush.button` rather than as a word.
  const locales = Object.entries({
    en: (await import('@/lib/i18n/en')).en,
    ko: (await import('@/lib/i18n/ko')).ko,
    ja: (await import('@/lib/i18n/ja')).ja,
    zh: (await import('@/lib/i18n/zh')).zh,
  });

  const keys = new Set<string>();
  for (const snapshot of COVERING_SNAPSHOTS) {
    for (const action of deriveGitActionMenu(snapshot)) {
      keys.add(action.labelKey);
      if (action.disabledReasonKey) keys.add(action.disabledReasonKey);
    }
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

test('every count the menu carries survives being rendered, in every locale', async () => {
  // `count` is i18next's plural selector, so a label that renders as a plain
  // string in one locale can go through a plural form in another and drop the
  // number the menu handed it.
  const counted = COVERING_SNAPSHOTS.flatMap((snapshot) =>
    deriveGitActionMenu(snapshot).filter((action) => action.labelParams),
  );
  assert.ok(counted.length > 0, 'no counted label was reached');

  const { i18n } = await import('@/lib/i18n');
  for (const language of ['en', 'ko', 'ja', 'zh']) {
    await i18n.changeLanguage(language);
    for (const action of counted) {
      const rendered = i18n.t(action.labelKey, action.labelParams);
      assert.match(
        rendered,
        new RegExp(String(action.labelParams!.count)),
        `${language} drops the count on ${action.labelKey}: ${rendered}`,
      );
    }
  }
  await i18n.changeLanguage('en');
});

test('state that is not known yet disables every action, and says so', () => {
  for (const entry of deriveGitActionMenu(null)) {
    assert.equal(entry.enabled, false, `${entry.id} is offered on unknown state`);
    // Not "nothing to do": Tessera switches sessions constantly and loads Git
    // state asynchronously, so a menu that answered from an absent snapshot
    // would be answering about the session before this one (ADR 0007).
    assert.equal(entry.disabledReasonKey, 'gitPanel.primary.stateUnknown');
  }
});

test('the menu lists every action, in the same order, whatever the state', () => {
  assert.deepEqual(GIT_MENU_ACTION_IDS, [
    'commit',
    'commit_push',
    'push',
    'pull',
    'create_pr',
    'open_source_control',
  ]);
  // Every state except a conflict, which appends the one entry that cannot be
  // drawn without one — covered above.
  const snapshots: (GitStateSnapshot | null)[] = [
    null,
    SYNCED,
    { ...SYNCED, changedFileCount: 4 },
    { ...SYNCED, ahead: 2 },
    { ...SYNCED, behind: 3 },
    { ...SYNCED, upstream: null },
    { ...SYNCED, hasRemote: false, upstream: null },
    { ...SYNCED, branch: null },
    { ...SYNCED, pullRequest: 'none' },
  ];

  for (const snapshot of snapshots) {
    const ids = deriveGitActionMenu(snapshot).map((entry) => entry.id);
    assert.deepEqual(
      ids,
      [...GIT_MENU_ACTION_IDS],
      `the menu changed shape for ${JSON.stringify(snapshot)}`,
    );
  }
});
