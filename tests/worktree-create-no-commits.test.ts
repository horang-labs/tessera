import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import {
  createGitWorktree,
  WorktreeCreationError,
} from '../src/lib/worktrees/create';
import type { GitRunner } from '../src/lib/worktrees/git-runner';

const execFileAsync = promisify(execFile);

async function git(args: string[], cwd: string) {
  return execFileAsync('git', args, { cwd });
}

const runGit: GitRunner = async (args) => {
  const { stdout, stderr } = await execFileAsync('git', args);
  return { stdout, stderr };
};

async function withFreshRepository(run: (repoDir: string, root: string) => Promise<void>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tessera-no-commits-'));
  const repoDir = path.join(root, 'repo');
  try {
    await git(['init', '-b', 'master', repoDir], root);
    await run(repoDir, root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

for (const baseRef of [null, 'master']) {
  test(`branch-off from a repository without commits is refused (baseRef=${baseRef})`, async () => {
    await withFreshRepository(async (repoDir, root) => {
      const worktreePath = path.join(root, 'wt');
      await assert.rejects(
        createGitWorktree({
          projectDir: repoDir,
          worktreePath,
          branchName: 'feature/x',
          source: { mode: 'branch-off', baseRef },
          runGit,
        }),
        (error: unknown) =>
          error instanceof WorktreeCreationError && error.code === 'no_commits',
      );
      assert.equal(fs.existsSync(worktreePath), false);
      const branches = (await git(['branch', '--list', 'feature/x'], repoDir)).stdout;
      assert.equal(branches.trim(), '');
    });
  });
}

test('a bad start ref in a repository with commits keeps Git\'s own error', async () => {
  await withFreshRepository(async (repoDir, root) => {
    await git(['config', 'user.email', 'test@example.com'], repoDir);
    await git(['config', 'user.name', 'Test User'], repoDir);
    await git(['commit', '--allow-empty', '-m', 'first'], repoDir);
    await assert.rejects(
      createGitWorktree({
        projectDir: repoDir,
        worktreePath: path.join(root, 'wt'),
        branchName: 'feature/x',
        source: { mode: 'branch-off', baseRef: 'does-not-exist' },
        runGit,
      }),
      (error: unknown) => !(error instanceof WorktreeCreationError),
    );
  });
});

test('branch-off works once the repository has its first commit', async () => {
  await withFreshRepository(async (repoDir, root) => {
    await git(['config', 'user.email', 'test@example.com'], repoDir);
    await git(['config', 'user.name', 'Test User'], repoDir);
    await git(['commit', '--allow-empty', '-m', 'first'], repoDir);
    const result = await createGitWorktree({
      projectDir: repoDir,
      worktreePath: path.join(root, 'wt'),
      branchName: 'feature/x',
      source: { mode: 'branch-off', baseRef: null },
      runGit,
    });
    assert.equal(result.createdBranch, true);
    assert.equal(
      (await git(['merge-base', 'master', 'feature/x'], repoDir)).stdout.trim().length > 0,
      true,
    );
  });
});
