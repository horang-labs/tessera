import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  resolveCommitSelectionAnchorPath,
  resolveCommitSelectionRange,
} from '../src/components/git/git-commit-selection';

const paths = ['a.ts', 'b.ts', 'c.ts', 'd.ts'];

test('a regular commit checkbox interaction selects only its file and sets the anchor', () => {
  assert.deepEqual(
    resolveCommitSelectionRange(paths, 'a.ts', 'c.ts', false),
    { anchorPath: 'c.ts', paths: ['c.ts'] },
  );
});

test('Shift commit checkbox interaction selects the inclusive visible range', () => {
  assert.deepEqual(
    resolveCommitSelectionRange(paths, 'b.ts', 'd.ts', true),
    { anchorPath: 'b.ts', paths: ['b.ts', 'c.ts', 'd.ts'] },
  );
  assert.deepEqual(
    resolveCommitSelectionRange(paths, 'd.ts', 'b.ts', true),
    { anchorPath: 'd.ts', paths: ['b.ts', 'c.ts', 'd.ts'] },
  );
});

test('Shift commit checkbox interaction replaces a missing polling anchor', () => {
  assert.deepEqual(
    resolveCommitSelectionRange(paths, 'removed.ts', 'c.ts', true),
    { anchorPath: 'c.ts', paths: ['c.ts'] },
  );
});

test('a commit selection anchor never crosses its canonical worktree target', () => {
  const anchor = { path: 'b.ts', targetKey: '/repo-a' };

  assert.equal(
    resolveCommitSelectionAnchorPath(anchor, '/repo-a', paths),
    'b.ts',
  );
  assert.equal(
    resolveCommitSelectionAnchorPath(anchor, '/repo-b', paths),
    null,
  );
  assert.equal(
    resolveCommitSelectionAnchorPath(anchor, '/repo-a', ['a.ts', 'c.ts']),
    null,
  );
});
