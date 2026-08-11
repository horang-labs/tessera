import assert from 'node:assert/strict';
import test from 'node:test';
import { restrictGitMenuToSession, restrictPrimaryGitActionToSession } from '@/lib/git/git-target-capabilities';
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

test('a sessionless Worktree keeps real Git state but does not offer dead mutations', () => {
  const primary = restrictPrimaryGitActionToSession(
    derivePrimaryGitAction(DIRTY),
    false,
  );
  const menu = restrictGitMenuToSession(deriveGitActionMenu(DIRTY), false);

  assert.equal(primary.kind, 'commit');
  assert.equal(primary.enabled, false);
  assert.equal(primary.disabledReasonKey, 'gitPanel.primary.sessionRequired');
  assert.equal(menu.find((action) => action.id === 'commit')?.enabled, false);
  assert.equal(
    menu.find((action) => action.id === 'commit')?.disabledReasonKey,
    'gitPanel.primary.sessionRequired',
  );
  assert.equal(menu.find((action) => action.id === 'open_source_control')?.enabled, true);
});

test('a Session keeps the Git ladder and menu unchanged', () => {
  const primary = derivePrimaryGitAction(DIRTY);
  const menu = deriveGitActionMenu(DIRTY);

  assert.strictEqual(restrictPrimaryGitActionToSession(primary, true), primary);
  assert.strictEqual(restrictGitMenuToSession(menu, true), menu);
});

test('a Worktree does not claim that session-owned PR discovery is still loading', () => {
  const unknownPr = { ...DIRTY, changedFileCount: 0, pullRequest: 'unknown' as const };
  const primary = restrictPrimaryGitActionToSession(
    derivePrimaryGitAction(unknownPr),
    false,
  );
  const createPr = restrictGitMenuToSession(
    deriveGitActionMenu(unknownPr),
    false,
  ).find((action) => action.id === 'create_pr');

  assert.equal(primary.disabledReasonKey, 'gitPanel.primary.sessionRequired');
  assert.equal(createPr?.disabledReasonKey, 'gitPanel.primary.sessionRequired');
});
