import assert from 'node:assert/strict';
import test from 'node:test';
import { deriveGitConflictRecovery } from '@/lib/git/git-conflict-recovery';
import { useGitStore } from '@/stores/git-store';
import type { GitPanelData } from '@/types/git';

const CONFLICTED_PANEL = {
  conflictOperation: 'rebase',
  changedFiles: [
    { path: 'src/unresolved.ts', state: 'conflicted' },
    { path: 'src/already-resolved.ts', state: 'modified' },
    { path: 'deleted-on-both.ts', state: 'conflicted' },
  ],
} as GitPanelData;

test('conflict recovery names the operation and presents only unresolved paths', () => {
  const recovery = deriveGitConflictRecovery(CONFLICTED_PANEL);

  assert.equal(recovery?.operation, 'rebase');
  assert.deepEqual(
    recovery?.unresolvedFiles.map((file) => file.path),
    ['src/unresolved.ts', 'deleted-on-both.ts'],
  );
});

test('opening conflict recovery navigates and requests focus without a git mutation', () => {
  const before = useGitStore.getState().conflictRecoveryFocusRequest;

  useGitStore.getState().openConflictRecovery();

  const state = useGitStore.getState();
  assert.equal(state.isOpen, true);
  assert.equal(state.panelTab, 'git');
  assert.equal(state.conflictRecoveryFocusRequest, before + 1);
});
