import assert from 'node:assert/strict';
import test from 'node:test';
import {
  derivePrimaryGitAction,
  gitStateSnapshotFromPanel,
  type GitStateSnapshot,
} from '@/lib/git/primary-git-action';
import type { GitPanelData } from '@/types/git';

const PANEL: GitPanelData = {
  sessionId: 's1',
  workDir: '/repo',
  repoRoot: '/repo',
  repoName: 'repo',
  worktreeName: 'repo',
  worktreePath: '/repo',
  branch: 'feature/0807-t233',
  upstream: 'origin/feature/0807-t233',
  ahead: 0,
  behind: 0,
  remoteUrl: 'git@github.com:horang-labs/tessera.git',
  repoUrl: null,
  defaultBranch: 'dev',
  branches: [],
  changedFiles: [],
  recentCommits: [],
  detached: false,
  hasRemote: true,
  github: { available: false, reasonCode: null, reason: null, pullRequest: null },
};

/** A branch that is committed, pushed and tracking — the quiet middle of the ladder. */
const SYNCED: GitStateSnapshot = {
  branch: 'feature/0807-t233',
  upstream: 'origin/feature/0807-t233',
  ahead: 0,
  behind: 0,
  changedFileCount: 0,
  hasRemote: true,
  defaultBranch: 'dev',
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

test('a clean branch that is behind offers Pull, and says how many commits', () => {
  const action = derivePrimaryGitAction({ ...SYNCED, behind: 2 });

  assert.equal(action.kind, 'pull');
  assert.equal(action.action, 'pull');
  assert.equal(action.enabled, true);
  assert.equal(action.labelKey, 'gitPanel.pull.button');
  // The size of the operation is visible before pressing (§4).
  assert.deepEqual(action.labelParams, { count: 2 });
});

test('a branch that is both ahead and behind is told to pull, not to push', () => {
  // The push would be refused as a non-fast-forward, so offering it would send
  // the user to a failure the ladder could see coming (§3).
  const action = derivePrimaryGitAction({ ...SYNCED, ahead: 4, behind: 1 });

  assert.equal(action.kind, 'pull');
  assert.deepEqual(action.labelParams, { count: 1 });
});

test('a branch with no upstream is not offered a pull it cannot run', () => {
  // `behind` cannot outlive the upstream it was counted against, but the panel
  // is polled and the two fields arrive together — so the rung asks for the
  // upstream itself rather than trusting a count that implies one.
  const action = derivePrimaryGitAction({
    ...SYNCED,
    upstream: null,
    behind: 3,
  });

  assert.notEqual(action.kind, 'pull');
  assert.equal(action.kind, 'publish');
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

test('a panel with no state yet is the unknown rung, not a clean tree', () => {
  assert.equal(gitStateSnapshotFromPanel(null), null);
});

test('a detached HEAD reaches the ladder as one, despite the panel labelling it', () => {
  // The panel renders a detached HEAD as `detached@<sha>` because that is what
  // the summary shows. Read as a branch name it would offer to publish a branch
  // called "detached@0f1e2d3".
  const snapshot = gitStateSnapshotFromPanel({
    ...PANEL,
    branch: 'detached@0f1e2d3',
    detached: true,
    upstream: null,
  });

  assert.equal(snapshot?.branch, null);
  assert.equal(
    derivePrimaryGitAction(snapshot).disabledReasonKey,
    'gitPanel.primary.detachedHead',
  );
});

test('a repository whose remote is not named origin can still push', () => {
  // `remoteUrl` is `git remote get-url origin` and is null here; the repository
  // has a remote all the same, and the execution layer will find it.
  const snapshot = gitStateSnapshotFromPanel({
    ...PANEL,
    remoteUrl: null,
    hasRemote: true,
    upstream: null,
  });

  const action = derivePrimaryGitAction(snapshot);
  assert.equal(action.kind, 'publish');
  assert.equal(action.enabled, true);
});

test('a truncated file list still counts as a dirty tree', () => {
  const snapshot = gitStateSnapshotFromPanel({
    ...PANEL,
    changedFiles: [],
    changedFilesTotal: 4000,
    changedFilesTruncated: true,
  });

  assert.equal(snapshot?.changedFileCount, 4000);
  assert.equal(derivePrimaryGitAction(snapshot).kind, 'commit');
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
    { ...SYNCED, behind: 2 },
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

test('the pull label spends the count it is given, in every locale', async () => {
  // The ladder handing over `labelParams` is only half of it. Rendered through
  // i18next rather than pattern-matched on the bundle, because that is where the
  // count can still go missing — `count` is i18next's plural selector, so a key
  // that resolves as a bare string in one locale can resolve through a plural
  // form in another.
  const behind = derivePrimaryGitAction({ ...SYNCED, behind: 5 });
  assert.deepEqual(behind.labelParams, { count: 5 });

  const { i18n } = await import('@/lib/i18n');
  for (const language of ['en', 'ko', 'ja', 'zh']) {
    await i18n.changeLanguage(language);
    const rendered = i18n.t(behind.labelKey, behind.labelParams);
    assert.match(rendered, /5/, `${language} drops the pull count: ${rendered}`);
  }
  await i18n.changeLanguage('en');
});
