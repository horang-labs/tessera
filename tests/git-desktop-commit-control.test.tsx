import assert from 'node:assert/strict';
import { test } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  GitWorkingTreeDiffStatButton,
  supportsDesktopGitControl,
} from '../src/components/git/git-desktop-commit-control';
import type { GitPanelData } from '../src/types/git';
import {
  gitPrimaryActionToneClassName,
  resolvePendingLabelKey,
} from '../src/components/git/git-primary-action';
import { derivePrimaryGitAction } from '../src/lib/git/primary-git-action';

const DIRTY_DATA = {
  changedFiles: [{ path: 'a.ts' }, { path: 'b.ts' }],
  changedFilesTruncated: false,
  diffStats: {
    added: 12,
    removed: 4,
    changedFiles: 2,
    newFiles: 0,
    deletedFiles: 0,
    computedAt: '2026-08-09T00:00:00.000Z',
  },
} as GitPanelData;

test('the desktop diff target exposes the whole worktree stat without relying on color', () => {
  const html = renderToStaticMarkup(
    <GitWorkingTreeDiffStatButton
      stats={DIRTY_DATA.diffStats!}
      accessibleLabel="Open Changed files: 12 additions, 4 deletions across 2 files"
      onOpen={() => {}}
    />,
  );

  assert.match(html, /aria-label="Open Changed files: 12 additions, 4 deletions across 2 files"/);
  assert.match(html, />\+12</);
  assert.match(html, />−4</);
});

test('every loaded worktree keeps the desktop Git control', () => {
  assert.equal(supportsDesktopGitControl(DIRTY_DATA), true);
  assert.equal(supportsDesktopGitControl({ ...DIRTY_DATA, changedFiles: [] }), true);
  assert.equal(
    supportsDesktopGitControl({ ...DIRTY_DATA, changedFilesTruncated: true }),
    true,
  );
  assert.equal(supportsDesktopGitControl(null), false);
  assert.equal(supportsDesktopGitControl(null, true), true);
});

test('pending copy names the menu action actually running', () => {
  const pull = derivePrimaryGitAction({
    branch: 'feature/test',
    upstream: 'origin/feature/test',
    ahead: 0,
    behind: 2,
    changedFileCount: 0,
    hasRemote: true,
    pullRequest: 'none',
    defaultBranch: 'main',
    conflictOperation: null,
  });

  assert.equal(
    resolvePendingLabelKey(pull, 'publish' as never),
    'gitPanel.push.publishButtonPending',
  );
});

test('the merged Task archive action uses the shared merged PR color token', () => {
  const mergedTone = gitPrimaryActionToneClassName('archive_worktree');
  const openTone = gitPrimaryActionToneClassName('view_pr');

  assert.match(mergedTone, /bg-\(--pr-merged-text\)/);
  assert.doesNotMatch(mergedTone, /bg-blue-/);
  assert.match(openTone, /bg-blue-600/);
});
