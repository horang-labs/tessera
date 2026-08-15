import assert from 'node:assert/strict';
import { test } from 'node:test';
import { useGitPanelStore } from '../src/stores/git-panel-store';

test('bulk commit selection selects and deselects every supplied path', () => {
  const worktreeKey = '/tmp/tessera-bulk-selection-test';

  useGitPanelStore.getState().setCommitFilesSelected(
    worktreeKey,
    ['a.ts', 'b.ts'],
    false,
  );
  assert.deepEqual(
    [...useGitPanelStore.getState().deliveryByWorktree[worktreeKey]!.deselectedPaths],
    ['a.ts', 'b.ts'],
  );

  useGitPanelStore.getState().setCommitFilesSelected(
    worktreeKey,
    ['a.ts', 'b.ts'],
    true,
  );
  assert.equal(
    useGitPanelStore.getState().deliveryByWorktree[worktreeKey]!.deselectedPaths.size,
    0,
  );
});
