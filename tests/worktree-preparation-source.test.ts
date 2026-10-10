import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { findWorktreeHoldingStartPoint } from '../src/lib/worktrees/create';
import type { GitRunner } from '../src/lib/worktrees/git-runner';

const execFileAsync = promisify(execFile);

const runGit: GitRunner = async (args) => {
  const { stdout, stderr } = await execFileAsync('git', args);
  return { stdout, stderr, exitCode: 0, truncated: false };
};

test('preparation copies from the worktree whose branch the new worktree was cut from', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tessera-prep-source-')));
  const repoDir = path.join(root, 'repo');
  const sourceDir = path.join(root, 'repo--feature-a');
  try {
    await runGit(['init', '-b', 'main', repoDir]);
    await runGit(['-C', repoDir, '-c', 'user.email=t@example.com', '-c', 'user.name=T', 'commit', '--allow-empty', '-m', 'init']);
    await runGit(['-C', repoDir, 'worktree', 'add', '-b', 'feature/a', sourceDir]);
    await runGit(['-C', repoDir, 'update-ref', 'refs/remotes/origin/feature/a', 'HEAD']);

    assert.equal(await findWorktreeHoldingStartPoint(repoDir, 'feature/a', 'feature/b', runGit), sourceDir);
    assert.equal(await findWorktreeHoldingStartPoint(repoDir, 'refs/heads/feature/a', 'feature/b', runGit), sourceDir);
    assert.equal(await findWorktreeHoldingStartPoint(repoDir, 'main', 'feature/b', runGit), repoDir);

    // No checkout to copy from: the caller falls back to the project checkout.
    assert.equal(await findWorktreeHoldingStartPoint(repoDir, 'HEAD', 'feature/b', runGit), null);
    assert.equal(await findWorktreeHoldingStartPoint(repoDir, null, 'feature/b', runGit), null);
    assert.equal(await findWorktreeHoldingStartPoint(repoDir, 'origin/feature/a', 'feature/b', runGit), null);
    // Checking out an existing branch makes the new worktree its holder.
    assert.equal(await findWorktreeHoldingStartPoint(repoDir, 'feature/a', 'feature/a', runGit), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
