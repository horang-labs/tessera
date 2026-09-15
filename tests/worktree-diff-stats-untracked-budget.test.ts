import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  computeWorktreeDiffStats,
  computeWorktreeFileDiffStats,
  UNTRACKED_LINECOUNT_MAX_FILES,
} from '@/lib/git/worktree-diff-stats';

function createGitWorktree(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tessera-diff-untracked-'));
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });
  execFileSync('git', ['commit', '--allow-empty', '-qm', 'initial'], { cwd: root });
  return root;
}

test('small untracked sets contribute exact added-line totals', async () => {
  const root = createGitWorktree();
  try {
    fs.writeFileSync(path.join(root, 'first.txt'), 'one\ntwo\n');
    fs.writeFileSync(path.join(root, 'second.txt'), 'three\n');

    const stats = await computeWorktreeDiffStats(root, 'native');
    const fileStats = await computeWorktreeFileDiffStats(root, 'native');

    assert.ok(stats);
    assert.equal(stats.added, 3);
    assert.equal(stats.addedLinesIncomplete, undefined);
    assert.equal(stats.newFiles, 2);
    assert.deepEqual(fileStats?.get('first.txt'), { added: 2, removed: 0 });
    assert.deepEqual(fileStats?.get('second.txt'), { added: 1, removed: 0 });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('oversized untracked sets stay bounded and report additions as incomplete', async () => {
  const root = createGitWorktree();
  try {
    for (let index = 0; index <= UNTRACKED_LINECOUNT_MAX_FILES; index += 1) {
      fs.writeFileSync(path.join(root, `untracked-${index}.txt`), 'line\n');
    }

    const stats = await computeWorktreeDiffStats(root, 'native');
    const fileStats = await computeWorktreeFileDiffStats(root, 'native');

    assert.ok(stats);
    assert.equal(stats.added, 0);
    assert.equal(stats.addedLinesIncomplete, true);
    assert.equal(stats.newFiles, UNTRACKED_LINECOUNT_MAX_FILES + 1);
    assert.equal(stats.changedFiles, UNTRACKED_LINECOUNT_MAX_FILES + 1);
    assert.equal(fileStats?.size, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an untracked file above the byte cap is unknown rather than a false +0', async () => {
  const root = createGitWorktree();
  try {
    fs.writeFileSync(path.join(root, 'large.txt'), Buffer.alloc((512 * 1024) + 1, 0x61));

    const stats = await computeWorktreeDiffStats(root, 'native');
    const fileStats = await computeWorktreeFileDiffStats(root, 'native');

    assert.ok(stats);
    assert.equal(stats.added, 0);
    assert.equal(stats.addedLinesIncomplete, true);
    assert.equal(stats.newFiles, 1);
    assert.equal(fileStats?.has('large.txt'), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
