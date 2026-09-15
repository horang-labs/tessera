import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  buildWorktreeDiffStatsBatchScript,
  computeWorktreeFileDiffStatsFromRaw,
  parseWorktreeDiffStatsBatchOutput,
} from '@/lib/git/worktree-diff-stats';

test('diff stats batch preserves NUL paths and emits Unicode numstat paths verbatim', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tessera-diff-batch-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });
    execFileSync('git', ['config', 'core.quotePath', 'true'], { cwd: root });
    fs.writeFileSync(path.join(root, 'tracked.txt'), 'before\n');
    const unicodePath = '윈미-씬-커버리지-가이드.md';
    fs.writeFileSync(path.join(root, unicodePath), 'a\nb\nc\nd\ne\n');
    execFileSync('git', ['add', 'tracked.txt', unicodePath], { cwd: root });
    execFileSync('git', ['commit', '-qm', 'initial'], { cwd: root });
    fs.writeFileSync(path.join(root, 'tracked.txt'), 'before\nafter\n');
    fs.writeFileSync(path.join(root, unicodePath), '1\n2\n3\n4\n5\n');
    fs.writeFileSync(path.join(root, 'new file.txt'), 'new\n');

    const raw = execFileSync('sh', ['-c', buildWorktreeDiffStatsBatchScript()], {
      cwd: root,
      encoding: 'utf8',
    });
    const parsed = parseWorktreeDiffStatsBatchOutput(raw);

    assert.ok(parsed);
    assert.equal(parsed.insideWorkTree, 'true');
    assert.match(parsed.numstat ?? '', /^1\t0\ttracked\.txt$/m);
    assert.match(parsed.numstat ?? '', new RegExp(`^5\\t5\\t${unicodePath}$`, 'm'));
    assert.match(parsed.nameStatus ?? '', /^M\ttracked\.txt$/m);
    assert.deepEqual(parsed.untracked?.split('\0').filter(Boolean), ['new file.txt']);

    const perFile = await computeWorktreeFileDiffStatsFromRaw(
      root,
      parsed.numstat,
      parsed.untracked,
    );
    assert.deepEqual(perFile?.get(unicodePath), { added: 5, removed: 5 });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('diff stats batch parser rejects partial output', () => {
  assert.equal(parseWorktreeDiffStatsBatchOutput('insideWorkTree\t0\tb64:dHJ1ZQ=='), null);
});
