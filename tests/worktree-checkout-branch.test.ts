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

async function withRepository(
  run: (fixture: {
    root: string;
    repoDir: string;
    runGit: GitRunner;
    localCommit: string;
    remoteCommit: string;
  }) => Promise<void>,
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tessera-checkout-branch-'));
  const repoDir = path.join(root, 'repo');
  try {
    await git(['init', '-b', 'main', repoDir], root);
    await git(['config', 'user.email', 'test@example.com'], repoDir);
    await git(['config', 'user.name', 'Test User'], repoDir);
    fs.writeFileSync(path.join(repoDir, 'file.txt'), 'main\n');
    await git(['add', 'file.txt'], repoDir);
    await git(['commit', '-m', 'main'], repoDir);

    await git(['checkout', '-b', 'feature/local'], repoDir);
    fs.writeFileSync(path.join(repoDir, 'file.txt'), 'local\n');
    await git(['commit', '-am', 'local work'], repoDir);
    const localCommit = (await git(['rev-parse', 'HEAD'], repoDir)).stdout.trim();
    await git(['config', 'branch.feature/local.base', 'refs/heads/main'], repoDir);

    await git(['checkout', '-b', 'feature/remote', 'main'], repoDir);
    fs.writeFileSync(path.join(repoDir, 'file.txt'), 'remote\n');
    await git(['commit', '-am', 'remote work'], repoDir);
    const remoteCommit = (await git(['rev-parse', 'HEAD'], repoDir)).stdout.trim();
    await git(['config', 'remote.upstream.url', path.join(root, 'upstream.git')], repoDir);
    await git([
      'config', 'remote.upstream.fetch',
      '+refs/heads/*:refs/remotes/upstream/*',
    ], repoDir);
    await git(['update-ref', 'refs/remotes/upstream/feature/remote', remoteCommit], repoDir);
    await git(['checkout', 'main'], repoDir);
    await git(['branch', '-D', 'feature/remote'], repoDir);

    await run({
      root,
      repoDir,
      runGit: async (args) => execFileAsync('git', args),
      localCommit,
      remoteCommit,
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('checkout-branch opens local and remote-only branches without losing lineage', async () => {
  await withRepository(async ({ root, repoDir, runGit, localCommit, remoteCommit }) => {
    const localPath = path.join(root, 'worktrees', 'feature-local');
    const remotePath = path.join(root, 'worktrees', 'feature-remote');

    await createGitWorktree({
      projectDir: repoDir,
      worktreePath: localPath,
      branchName: 'feature/local',
      source: { mode: 'checkout-branch', branch: 'feature/local' },
      runGit,
    });
    await createGitWorktree({
      projectDir: repoDir,
      worktreePath: remotePath,
      branchName: 'feature/remote',
      source: { mode: 'checkout-branch', branch: 'upstream/feature/remote' },
      runGit,
    });

    assert.equal((await git(['symbolic-ref', '--short', 'HEAD'], localPath)).stdout.trim(), 'feature/local');
    assert.equal((await git(['rev-parse', 'HEAD'], localPath)).stdout.trim(), localCommit);
    assert.equal(
      (await git(['config', '--get', 'branch.feature/local.base'], repoDir)).stdout.trim(),
      'refs/heads/main',
    );
    assert.equal((await git(['symbolic-ref', '--short', 'HEAD'], remotePath)).stdout.trim(), 'feature/remote');
    assert.equal((await git(['rev-parse', 'HEAD'], remotePath)).stdout.trim(), remoteCommit);

    const upstream = await git(
      ['config', '--get-regexp', '^branch\\.feature/remote\\.(remote|merge)$'],
      repoDir,
    );
    assert.equal(upstream.stdout.trim(), [
      'branch.feature/remote.remote upstream',
      'branch.feature/remote.merge refs/heads/feature/remote',
    ].join('\n'));
    assert.equal(
      await git(['config', '--get', 'branch.feature/remote.base'], repoDir)
        .then(({ stdout }) => stdout.trim(), () => ''),
      '',
    );
  });
});

test('checkout-branch refuses missing and already-held branches without creating a path', async () => {
  await withRepository(async ({ root, repoDir, runGit }) => {
    const missingPath = path.join(root, 'worktrees', 'missing');
    await assert.rejects(
      createGitWorktree({
        projectDir: repoDir,
        worktreePath: missingPath,
        branchName: 'feature/missing',
        source: { mode: 'checkout-branch', branch: 'feature/missing' },
        runGit,
      }),
      (error) => error instanceof WorktreeCreationError && error.code === 'branch_not_found',
    );
    assert.equal(fs.existsSync(missingPath), false);

    const heldPath = path.join(root, 'worktrees', 'held');
    await assert.rejects(createGitWorktree({
      projectDir: repoDir,
      worktreePath: heldPath,
      branchName: 'main',
      source: { mode: 'checkout-branch', branch: 'main' },
      runGit,
    }));
    assert.equal(fs.existsSync(heldPath), false);
  });
});
