import assert from 'node:assert/strict';
import test from 'node:test';
import { parseGitActionBody } from '@/lib/git/git-action-request';
import { canRevertFile } from '@/lib/git/revert-eligibility';
import type { GitChangedFile } from '@/types/git';

function file(overrides: Partial<GitChangedFile>): GitChangedFile {
  return {
    path: 'a.txt',
    indexStatus: ' ',
    workTreeStatus: 'M',
    state: 'modified',
    staged: false,
    unstaged: true,
    displayStatus: ' M',
    ...overrides,
  };
}

test('parseGitActionBody accepts a revert with file paths', () => {
  const parsed = parseGitActionBody({ action: 'revert', files: ['a.txt', 'b.txt'] });
  assert.deepEqual(parsed, { action: { action: 'revert', files: ['a.txt', 'b.txt'] } });
});

test('parseGitActionBody rejects a revert without a file list', () => {
  const parsed = parseGitActionBody({ action: 'revert' });
  assert.ok('message' in parsed);
});

test('parseGitActionBody accepts an empty revert list (the runner refuses it)', () => {
  // Matching the commit parser: an empty array parses, and the execution layer
  // rejects it with `no_files_selected` rather than the layer that parses.
  assert.deepEqual(parseGitActionBody({ action: 'revert', files: [] }), {
    action: { action: 'revert', files: [] },
  });
});

test('canRevertFile permits an unstaged modification', () => {
  assert.equal(canRevertFile(file({})), true);
});

test('canRevertFile permits untracked files', () => {
  assert.equal(
    canRevertFile(file({ state: 'untracked', indexStatus: '?', workTreeStatus: '?', staged: false })),
    true,
  );
});

test('canRevertFile refuses conflicted files', () => {
  assert.equal(canRevertFile(file({ state: 'conflicted' })), false);
});

test('canRevertFile refuses a staged-only change', () => {
  assert.equal(
    canRevertFile(file({ staged: true, unstaged: false, indexStatus: 'M', workTreeStatus: ' ' })),
    false,
  );
});
