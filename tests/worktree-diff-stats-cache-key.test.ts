import assert from 'node:assert/strict';
import test from 'node:test';
import {
  normalizeWorktreeDiffStatsCacheKey,
  preferWorktreeDiffStatsBroadcastPath,
} from '@/lib/git/worktree-diff-stats-cache';

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

test('broadcasts preserve the canonical Windows-hosted path while cache keys collapse to WSL', () => {
  const wslPath = '/home/work/Source/tessera-dev';
  const canonicalPath = '\\\\wsl.localhost\\Ubuntu-24.04\\home\\work\\Source\\tessera-dev';

  assert.equal(preferWorktreeDiffStatsBroadcastPath(undefined, wslPath), wslPath);
  assert.equal(preferWorktreeDiffStatsBroadcastPath(wslPath, canonicalPath), canonicalPath);
  assert.equal(preferWorktreeDiffStatsBroadcastPath(canonicalPath, wslPath), canonicalPath);
  assert.equal(normalizeWorktreeDiffStatsCacheKey(canonicalPath), wslPath);
});
