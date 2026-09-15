import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  collectUntrackedLineCounts,
  computeWorktreeDiffStats,
  computeWorktreeFileDiffStats,
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

test('crossing 1000 small untracked files does not discard every new-file line count', async () => {
  const root = createGitWorktree();
  const fileCount = 1001;
  try {
    for (let index = 0; index < fileCount; index += 1) {
      fs.writeFileSync(path.join(root, `untracked-${index}.txt`), 'line\n');
    }

    const stats = await computeWorktreeDiffStats(root, 'native');
    const fileStats = await computeWorktreeFileDiffStats(root, 'native');

    assert.ok(stats);
    assert.equal(stats.added, fileCount);
    assert.equal(stats.addedLinesIncomplete, undefined);
    assert.equal(stats.newFiles, fileCount);
    assert.equal(stats.changedFiles, fileCount);
    assert.equal(fileStats?.size, fileCount);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the aggregate byte budget bounds dependency-like trees without a file-count cliff', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tessera-diff-budget-'));
  try {
    fs.writeFileSync(path.join(root, 'first.txt'), 'one\n');
    fs.writeFileSync(path.join(root, 'second.txt'), 'two\n');

    const counts = await collectUntrackedLineCounts(
      root,
      ['first.txt', 'second.txt'],
      { maxBytes: 4, maxDurationMs: 10_000 },
    );

    assert.deepEqual(Array.from(counts.byPath), [['first.txt', 1]]);
    assert.equal(counts.incomplete, true);
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

test('binary newline bytes do not become source-code additions', async () => {
  const root = createGitWorktree();
  try {
    fs.writeFileSync(
      path.join(root, 'image.png'),
      Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00]),
        Buffer.alloc(2_000, 0x0a),
      ]),
    );

    const stats = await computeWorktreeDiffStats(root, 'native');
    const fileStats = await computeWorktreeFileDiffStats(root, 'native');

    assert.ok(stats);
    assert.equal(stats.added, 0);
    assert.equal(stats.addedLinesIncomplete, undefined);
    assert.deepEqual(fileStats?.get('image.png'), { added: 0, removed: 0 });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
