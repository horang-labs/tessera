import assert from 'node:assert/strict';
import { test } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  GitWorkingTreeDiffStatButton,
  supportsDesktopDeliveryControl,
} from '../src/components/git/git-desktop-commit-control';
import type { GitPanelData } from '../src/types/git';

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

test('only complete dirty commit states opt into the desktop control', () => {
  assert.equal(supportsDesktopDeliveryControl(DIRTY_DATA, 'commit'), true);
  assert.equal(supportsDesktopDeliveryControl(DIRTY_DATA, 'conflict'), true);
  assert.equal(
    supportsDesktopDeliveryControl({ ...DIRTY_DATA, changedFilesTruncated: true }, 'commit'),
    false,
  );
  assert.equal(
    supportsDesktopDeliveryControl({ ...DIRTY_DATA, diffStats: null }, 'commit'),
    false,
  );
});
