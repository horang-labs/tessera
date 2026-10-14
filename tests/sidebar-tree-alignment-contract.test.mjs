import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const collectionGroupSource = readFileSync(
  new URL('../src/components/chat/collection-group.tsx', import.meta.url),
  'utf8',
);
const collectionRowsSource = readFileSync(
  new URL('../src/components/chat/collection-group-sections.tsx', import.meta.url),
  'utf8',
);
const kanbanCardSource = readFileSync(
  new URL('../src/components/board/kanban-card.tsx', import.meta.url),
  'utf8',
);
const allProjectsSource = readFileSync(
  new URL('../src/components/chat/all-projects-list.tsx', import.meta.url),
  'utf8',
);
const treeLayoutSource = readFileSync(
  new URL('../src/components/chat/sidebar-tree-layout.ts', import.meta.url),
  'utf8',
);

test('sidebar tree fixes its shared gutter and hierarchy to the intended pixel grid', () => {
  assert.match(treeLayoutSource, /SIDEBAR_TREE_ROW_GUTTER = 'mx-0 px-2'/);
  assert.match(treeLayoutSource, /SIDEBAR_TREE_ROW_SPACING = 'gap-1\.5 py-1'/);
  assert.match(treeLayoutSource, /SIDEBAR_TREE_CHILD_INDENT = 'ml-3'/);
  assert.match(treeLayoutSource, /SIDEBAR_TREE_TWISTIE_SLOT = 'flex h-3\.5 w-3\.5/);
  assert.match(treeLayoutSource, /SIDEBAR_TREE_LEADING_SLOT = 'flex h-3\.5 w-3\.5/);
  // gutter 8px + half the 14px twistie - 12px indent: the guide sits under the parent chevron.
  assert.match(treeLayoutSource, /SIDEBAR_TREE_INDENT_GUIDE =\s*'[^']*left-\[3px\] w-px/);
});

test('collection, task, chat, and sub-session rows share one twistie + icon grid', () => {
  assert.equal((collectionGroupSource.match(/SIDEBAR_TREE_ROW_GUTTER/g) ?? []).length, 2);
  assert.equal((collectionGroupSource.match(/SIDEBAR_TREE_ROW_SPACING/g) ?? []).length, 2);
  assert.equal((collectionGroupSource.match(/SIDEBAR_TREE_TWISTIE_SLOT/g) ?? []).length, 2);
  assert.equal((collectionGroupSource.match(/SIDEBAR_TREE_LEADING_SLOT/g) ?? []).length, 2);
  assert.equal((collectionRowsSource.match(/SIDEBAR_TREE_ROW_GUTTER/g) ?? []).length, 4);
  assert.equal((collectionRowsSource.match(/SIDEBAR_TREE_ROW_SPACING/g) ?? []).length, 4);
  assert.equal((collectionRowsSource.match(/SIDEBAR_TREE_TWISTIE_SLOT/g) ?? []).length, 4);
});

test('every expandable level draws an indent guide and an always-visible rotating chevron', () => {
  assert.equal((collectionGroupSource.match(/SIDEBAR_TREE_INDENT_GUIDE/g) ?? []).length, 2);
  assert.equal((collectionRowsSource.match(/SIDEBAR_TREE_INDENT_GUIDE/g) ?? []).length, 2);
  assert.match(collectionGroupSource, /SIDEBAR_TREE_CHEVRON, !isCollapsed && 'rotate-90'/);
  assert.match(collectionRowsSource, /SIDEBAR_TREE_CHEVRON, isExpanded && 'rotate-90'/);
  // The collection chevron no longer hides behind the tag icon until hover.
  assert.doesNotMatch(collectionGroupSource, /group-hover\/collection:opacity-0/);
  assert.match(allProjectsSource, /absolute inset-y-0 -left-0\.5 w-px bg-\(--divider\)/);
});

test('board worktree children keep their surface-adjusted compact branch insets', () => {
  assert.match(treeLayoutSource, /SIDEBAR_TREE_WORKTREE_CARD_CHILD_BRANCH = 'ml-2'/);
  assert.match(treeLayoutSource, /SIDEBAR_TREE_WORKTREE_CHILD_CONNECTOR_OFFSET = 'left-0'/);
  assert.equal((kanbanCardSource.match(/SIDEBAR_TREE_WORKTREE_CARD_CHILD_BRANCH/g) ?? []).length, 2);
  assert.equal((kanbanCardSource.match(/SIDEBAR_TREE_WORKTREE_CHILD_CONNECTOR_OFFSET/g) ?? []).length, 3);
  assert.doesNotMatch(kanbanCardSource, /className="relative ml-\[22px\] pl-3/);
  assert.doesNotMatch(kanbanCardSource, /className="absolute -left-3 top-1\/2/);
  assert.match(kanbanCardSource, /'relative mt-0\.5 border-t border-\(--divider\) pt-0\.5'/);
});

test('all-projects header joins the same icon and label columns', () => {
  assert.match(allProjectsSource, /rounded-md py-1\.5 pl-0 pr-2/);
  assert.match(allProjectsSource, /h-4 w-4[^\"]*mr-0\.5/);
});
