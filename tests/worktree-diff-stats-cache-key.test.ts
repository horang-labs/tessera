import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeWorktreeDiffStatsCacheKey } from '@/lib/git/worktree-diff-stats-cache';

test('WSL display and UNC spellings share one diff-stats cache key', () => {
  assert.equal(
    normalizeWorktreeDiffStatsCacheKey(
      '\\\\wsl.localhost\\Ubuntu-24.04\\home\\work\\Source\\tessera-dev',
    ),
    normalizeWorktreeDiffStatsCacheKey('/home/work/Source/tessera-dev'),
  );
});

test('Windows-native drive paths retain Windows path semantics', () => {
  assert.equal(
    normalizeWorktreeDiffStatsCacheKey('C:\\Users\\work\\repo'),
    'C:\\Users\\work\\repo',
  );
});
