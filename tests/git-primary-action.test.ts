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

/**
 * A branch that is committed, pushed, tracking and already has a pull request —
 * the far end of the ladder, where delivery is finished.
 */
const SYNCED: GitStateSnapshot = {
  branch: 'feature/0807-t233',
  upstream: 'origin/feature/0807-t233',
  ahead: 0,
  behind: 0,
  changedFileCount: 0,
  hasRemote: true,
  pullRequest: 'exists',
  defaultBranch: 'dev',
  conflictOperation: null,
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

test('a synced branch with no pull request offers Create PR', () => {
  const action = derivePrimaryGitAction({ ...SYNCED, pullRequest: 'none' });

  assert.equal(action.kind, 'create_pr');
  assert.equal(action.action, 'create_pr');
  assert.equal(action.enabled, true);
  assert.equal(action.labelKey, 'gitPanel.pr.createButton');
});

test('a branch that already has a pull request is not offered another', () => {
  const action = derivePrimaryGitAction(SYNCED);

  assert.notEqual(action.kind, 'create_pr');
  assert.equal(action.enabled, false);
});

test('a repository that cannot host a pull request says why, rather than offering one', () => {
  const action = derivePrimaryGitAction({ ...SYNCED, pullRequest: 'unsupported' });

  assert.equal(action.kind, 'create_pr');
  assert.equal(action.enabled, false);
  assert.equal(action.disabledReasonKey, 'gitPanel.pr.unavailable');
});

test('a pull request state that has not arrived yet holds a disabled frame', () => {
  // The same rule as the unknown Git state above: GitHub is asked over the
  // network, and "not answered yet" must not read as "no pull request".
  const action = derivePrimaryGitAction({ ...SYNCED, pullRequest: 'unknown' });

  assert.equal(action.kind, 'create_pr');
  assert.equal(action.enabled, false);
  assert.equal(action.disabledReasonKey, 'gitPanel.pr.statusUnknown');
});

test('pushing rotates the same button from Push to Create PR', () => {
  const ahead = derivePrimaryGitAction({ ...SYNCED, ahead: 2, pullRequest: 'none' });
  // What the panel reads back once the push lands: nothing ahead, no PR yet.
  const pushed = derivePrimaryGitAction({ ...SYNCED, pullRequest: 'none' });

  assert.equal(ahead.kind, 'push');
  assert.equal(pushed.kind, 'create_pr');
});

test('a branch that is behind pulls before it is offered a pull request', () => {
  // Where the two new rungs meet: §3 puts `clean + behind` above
  // `clean + synced + no PR`, so being behind outranks having no pull request.
  const action = derivePrimaryGitAction({
    ...SYNCED,
    behind: 2,
    pullRequest: 'none',
  });

  assert.equal(action.kind, 'pull');
  assert.equal(action.labelParams?.count, 2);
});

test('Create PR waits until the branch is synced in both directions', () => {
  const behind = derivePrimaryGitAction({ ...SYNCED, behind: 1, pullRequest: 'none' });
  const ahead = derivePrimaryGitAction({ ...SYNCED, ahead: 1, pullRequest: 'none' });
  const synced = derivePrimaryGitAction({ ...SYNCED, pullRequest: 'none' });

  assert.equal(behind.kind, 'pull');
  assert.equal(ahead.kind, 'push');
  assert.equal(synced.kind, 'create_pr');
});

test('the default branch is not offered a pull request it would open against itself', () => {
  const action = derivePrimaryGitAction({
    ...SYNCED,
    branch: 'dev',
    upstream: 'origin/dev',
    pullRequest: 'none',
  });

  assert.equal(action.enabled, false);
  assert.equal(action.disabledReasonKey, 'gitPanel.pr.defaultBranch');
});

test('a repository that never resolved a default branch still offers Create PR', () => {
  // `defaultBranch` is read from `refs/remotes/origin/HEAD`, which a clone can
  // legitimately lack. Not knowing must not withhold the action.
  const action = derivePrimaryGitAction({
    ...SYNCED,
    defaultBranch: null,
    pullRequest: 'none',
  });

  assert.equal(action.enabled, true);
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

test('a conflict outranks dirty state with an enabled recovery path', () => {
  // A stopped merge leaves a tree full of conflicted files, so the dirty rung
  // would otherwise claim it and offer a commit Git refuses (§9). The conflict
  // rung sits above it for exactly that reason.
  const action = derivePrimaryGitAction({
    ...SYNCED,
    changedFileCount: 3,
    conflictOperation: 'merge',
  });

  assert.equal(action.kind, 'conflict');
  assert.equal(action.action, 'resolve_conflicts');
  assert.equal(action.enabled, true);
  assert.equal(action.labelKey, 'gitPanel.conflict.resolve');
  assert.equal(action.disabledReasonKey, null);
});

test('every supported conflict operation derives the same recovery navigation', () => {
  const rebase = derivePrimaryGitAction({ ...SYNCED, conflictOperation: 'rebase' });
  const cherryPick = derivePrimaryGitAction({
    ...SYNCED,
    conflictOperation: 'cherry_pick',
  });

  assert.equal(rebase.action, 'resolve_conflicts');
  assert.equal(cherryPick.action, 'resolve_conflicts');
});

test('a conflict recovery path outranks the branch rungs too', () => {
  // Nothing below the conflict rung is reachable while one is in progress: a
  // clean-looking tree mid-rebase would otherwise be offered a push.
  const action = derivePrimaryGitAction({
    ...SYNCED,
    ahead: 2,
    conflictOperation: 'rebase',
  });

  assert.equal(action.kind, 'conflict');
  assert.equal(action.enabled, true);
});

test('aborting rotates the button back to a normal action', () => {
  const conflicted = derivePrimaryGitAction({
    ...SYNCED,
    changedFileCount: 3,
    conflictOperation: 'merge',
  });
  // What the panel reads back once the abort lands: the operation is gone and
  // the tree it conflicted is gone with it (§9).
  const aborted = derivePrimaryGitAction(SYNCED);

  assert.equal(conflicted.kind, 'conflict');
  assert.equal(aborted.kind, 'push');
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

test('a linked pull request reaches the ladder however the panel learned of it', () => {
  // `github.pullRequest` is always null on the wire; the PR the panel actually
  // shows arrives as `prStatus`, merged in from the live PR store.
  const snapshot = gitStateSnapshotFromPanel({
    ...PANEL,
    github: { ...PANEL.github, available: true, reasonCode: null },
    prStatus: {
      number: 236,
      url: 'https://github.com/horang-labs/tessera/pull/236',
      state: 'open',
      relation: 'current',
      lastSynced: '2026-08-07T00:00:00.000Z',
    },
  });

  assert.equal(snapshot?.pullRequest, 'exists');
});

test('a historical pull request remains visible without blocking Create PR', () => {
  const snapshot = gitStateSnapshotFromPanel({
    ...PANEL,
    prStatusKnown: true,
    github: { ...PANEL.github, available: true, reasonCode: null },
    prStatus: {
      number: 235,
      url: 'https://github.com/horang-labs/tessera/pull/235',
      state: 'merged',
      relation: 'historical',
      lastSynced: '2026-08-07T00:00:00.000Z',
    },
  });

  assert.equal(snapshot?.pullRequest, 'none');
  assert.equal(derivePrimaryGitAction(snapshot).kind, 'create_pr');
  assert.equal(derivePrimaryGitAction(snapshot).enabled, true);
});

test('an unknown probe fails closed even when the saved PR is historical', () => {
  const snapshot = gitStateSnapshotFromPanel({
    ...PANEL,
    prStatusKnown: false,
    prStatus: {
      number: 235,
      url: 'https://github.com/horang-labs/tessera/pull/235',
      state: 'merged',
      relation: 'historical',
      lastSynced: '2026-08-07T00:00:00.000Z',
    },
  });

  assert.equal(snapshot?.pullRequest, 'unknown');
  assert.equal(derivePrimaryGitAction(snapshot).enabled, false);
});

test('GitHub answering "no pull request" is what unlocks Create PR', () => {
  const snapshot = gitStateSnapshotFromPanel({
    ...PANEL,
    github: {
      ...PANEL.github,
      available: true,
      reasonCode: 'no_pull_request',
      reason: 'No pull request is linked to the current branch.',
    },
  });

  assert.equal(snapshot?.pullRequest, 'none');
  assert.equal(derivePrimaryGitAction(snapshot).enabled, true);
});

test('a repository GitHub cannot answer for is unsupported, not pull-request-free', () => {
  const notGitHub = gitStateSnapshotFromPanel({
    ...PANEL,
    github: { ...PANEL.github, reasonCode: 'not_github_remote' },
  });
  // The PR probe reports the same conclusion from the other side — a missing or
  // signed-out `gh` cannot open a pull request either.
  const noGhCli = gitStateSnapshotFromPanel({
    ...PANEL,
    github: { ...PANEL.github, available: true, reasonCode: 'no_pull_request' },
    prUnsupported: true,
  });

  assert.equal(notGitHub?.pullRequest, 'unsupported');
  assert.equal(noGhCli?.pullRequest, 'unsupported');
});

test('a panel whose GitHub state has not arrived reports it as unknown', () => {
  const snapshot = gitStateSnapshotFromPanel({
    ...PANEL,
    github: { ...PANEL.github, reasonCode: 'unknown' },
  });

  assert.equal(snapshot?.pullRequest, 'unknown');
});

test('the default branch reaches the ladder as the panel reports it', () => {
  const snapshot = gitStateSnapshotFromPanel({ ...PANEL, defaultBranch: 'dev' });

  assert.equal(snapshot?.defaultBranch, 'dev');
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
    { ...SYNCED, pullRequest: 'none' as const },
    { ...SYNCED, pullRequest: 'unknown' as const },
    { ...SYNCED, pullRequest: 'unsupported' as const },
    { ...SYNCED, branch: 'dev', upstream: 'origin/dev', pullRequest: 'none' as const },
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
