import assert from 'node:assert/strict';
import test from 'node:test';
import { deriveGitActionMenu } from '@/lib/git/git-action-menu';
import { derivePrimaryGitAction, type GitStateSnapshot } from '@/lib/git/primary-git-action';

const DIRTY: GitStateSnapshot = {
  branch: 'feature/worktree',
  upstream: 'origin/feature/worktree',
  ahead: 0,
  behind: 0,
  changedFileCount: 2,
  hasRemote: true,
  pullRequest: 'none',
  defaultBranch: 'main',
  conflictOperation: null,
};

test('a sessionless Worktree offers the same Git mutations as a Session', () => {
  const primary = derivePrimaryGitAction(DIRTY);
  const menu = deriveGitActionMenu(DIRTY);

  assert.equal(primary.kind, 'commit');
  assert.equal(primary.enabled, true);
  assert.equal(menu.find((action) => action.id === 'commit')?.enabled, true);
  assert.equal(menu.find((action) => action.id === 'open_source_control')?.enabled, true);
});

test('the Git ladder and menu are target-independent', () => {
  const primary = derivePrimaryGitAction(DIRTY);
  const menu = deriveGitActionMenu(DIRTY);

  assert.equal(primary.enabled, true);
  assert.equal(menu.find((action) => action.id === 'commit_push')?.enabled, true);
});

test('a Worktree keeps repository-derived PR discovery state', () => {
  const unknownPr = { ...DIRTY, changedFileCount: 0, pullRequest: 'unknown' as const };
  const primary = derivePrimaryGitAction(unknownPr);
  const createPr = deriveGitActionMenu(unknownPr)
    .find((action) => action.id === 'create_pr');

  assert.equal(primary.disabledReasonKey, 'gitPanel.pr.statusUnknown');
  assert.equal(createPr?.disabledReasonKey, 'gitPanel.pr.statusUnknown');
});
