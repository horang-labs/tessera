import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import {
  detectGitConflictOperation,
  resolveWorktreeGitDir,
} from '@/lib/git/git-conflict-state';

const execFileAsync = promisify(execFile);

async function configureIdentity(cwd: string): Promise<void> {
  await execFileAsync('git', ['config', 'user.email', 'tessera@tessera.local'], { cwd });
  await execFileAsync('git', ['config', 'user.name', 'Tessera'], { cwd });
  await execFileAsync('git', ['config', 'commit.gpgsign', 'false'], { cwd });
}

/**
 * Two branches that touched the same line, so every one of the three operations
 * under test stops in the middle when it is asked to replay one over the other.
 * A real repository rather than a directory of planted marker files: what the
 * probe reads is whatever Git actually leaves behind, and planting the files
 * ourselves would only read our own guess back.
 */
async function withDivergedRepo(
  run: (repoDir: string) => Promise<void>,
): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tessera-git-conflict-'));
  const repoDir = path.join(root, 'work');

  try {
    await execFileAsync('git', ['init', '--initial-branch=main', repoDir]);
    await configureIdentity(repoDir);
    fs.writeFileSync(path.join(repoDir, 'file.txt'), 'base\n');
    await execFileAsync('git', ['add', '.'], { cwd: repoDir });
    await execFileAsync('git', ['commit', '-m', 'base'], { cwd: repoDir });

    await execFileAsync('git', ['checkout', '-b', 'other'], { cwd: repoDir });
    fs.writeFileSync(path.join(repoDir, 'file.txt'), 'other\n');
    await execFileAsync('git', ['commit', '-am', 'other'], { cwd: repoDir });

    await execFileAsync('git', ['checkout', 'main'], { cwd: repoDir });
    fs.writeFileSync(path.join(repoDir, 'file.txt'), 'main\n');
    await execFileAsync('git', ['commit', '-am', 'main'], { cwd: repoDir });

    await run(repoDir);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

/** Git exits non-zero when it stops on a conflict; that is the state we want. */
async function runExpectingConflict(args: string[], cwd: string): Promise<void> {
  await execFileAsync('git', args, { cwd }).catch(() => null);
}

test('a worktree stopped mid-merge reports a merge', async () => {
  await withDivergedRepo(async (repoDir) => {
    await runExpectingConflict(['merge', 'other'], repoDir);

    assert.equal(await detectGitConflictOperation(repoDir), 'merge');
  });
});

test('a worktree stopped mid-rebase reports a rebase', async () => {
  await withDivergedRepo(async (repoDir) => {
    await runExpectingConflict(['rebase', 'other'], repoDir);

    // A rebase replays commits the way a cherry-pick does, so the answer that
    // matters is the one that names the abort which puts this worktree back.
    assert.equal(await detectGitConflictOperation(repoDir), 'rebase');
  });
});

test('a worktree stopped mid-cherry-pick reports a cherry-pick', async () => {
  await withDivergedRepo(async (repoDir) => {
    await runExpectingConflict(['cherry-pick', 'other'], repoDir);

    assert.equal(await detectGitConflictOperation(repoDir), 'cherry_pick');
  });
});

test('a worktree with nothing in progress reports no conflict', async () => {
  await withDivergedRepo(async (repoDir) => {
    assert.equal(await detectGitConflictOperation(repoDir), null);
  });
});

test('a finished operation stops being reported', async () => {
  await withDivergedRepo(async (repoDir) => {
    await runExpectingConflict(['rebase', 'other'], repoDir);
    await execFileAsync('git', ['rebase', '--abort'], { cwd: repoDir });

    // `REBASE_HEAD` survives the abort, which is why it is not what the probe
    // reads: a worktree that reported a rebase forever could never be committed
    // in again.
    assert.equal(await detectGitConflictOperation(repoDir), null);
  });
});

test('a linked worktree reports its own operation, not the main checkout one', async () => {
  await withDivergedRepo(async (repoDir) => {
    const linkedDir = path.join(repoDir, '..', 'linked');
    await execFileAsync('git', ['worktree', 'add', linkedDir, 'other'], {
      cwd: repoDir,
    });
    await configureIdentity(linkedDir);
    await runExpectingConflict(['merge', 'main'], linkedDir);

    // `.git` in a linked worktree is a file pointing at a directory under the
    // main repository's `worktrees/`; that directory is where this merge's
    // `MERGE_HEAD` lives. Most Tessera sessions run in one of these.
    assert.equal(await detectGitConflictOperation(linkedDir), 'merge');
    // And the main checkout, which merged nothing, still says so.
    assert.equal(await detectGitConflictOperation(repoDir), null);
  });
});

test('detection runs no git command, so a panel read costs no extra process', async () => {
  await withDivergedRepo(async (repoDir) => {
    await runExpectingConflict(['merge', 'other'], repoDir);
    // §9 asks detection to cost the panel nothing on a normal read, which is
    // why it probes the filesystem instead of asking Git. With no `git` to
    // reach, an implementation that shelled out could only answer null.
    const originalPath = process.env.PATH;
    process.env.PATH = '';

    try {
      assert.equal(await detectGitConflictOperation(repoDir), 'merge');
    } finally {
      process.env.PATH = originalPath;
    }
  });
});

/**
 * The bridged setup CLAUDE.md warns about: the server and the CLI are on
 * different filesystems, so the path Git wrote into a linked worktree's `.git`
 * file is not a path this process can open. A plain `path.resolve` against the
 * already-translated worktree happens to look right for a distro path and is
 * silently wrong for a `/mnt/<drive>` one — which is the whole reason the
 * translation goes through the same helper the worktree itself did.
 */
async function withPointerWorktree(
  gitdirValue: string,
  run: (worktreeDir: string) => Promise<void>,
): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tessera-git-gitdir-'));

  try {
    fs.writeFileSync(path.join(root, '.git'), `gitdir: ${gitdirValue}\n`);
    await run(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('a worktree pointing at a Windows-mounted git directory resolves to the drive', async () => {
  await withPointerWorktree('/mnt/c/repo/.git/worktrees/feature', async (worktreeDir) => {
    // The reference is a Windows-hosted path, as it is when the server runs on
    // Windows and the agent in WSL. Resolved against the worktree instead, this
    // would come back under the distro root, where `C:\repo` is not.
    const gitDir = await resolveWorktreeGitDir(
      worktreeDir,
      '\\\\wsl.localhost\\Ubuntu-24.04\\home\\work\\wt',
    );

    assert.equal(gitDir, 'C:\\repo\\.git\\worktrees\\feature');
  });
});

test('a gitdir written relative to the worktree is resolved against it', async () => {
  await withPointerWorktree('../repo/.git/worktrees/feature', async (worktreeDir) => {
    const gitDir = await resolveWorktreeGitDir(worktreeDir, worktreeDir);

    assert.equal(gitDir, path.resolve(worktreeDir, '../repo/.git/worktrees/feature'));
  });
});

test('a directory that is not a repository reports no conflict rather than throwing', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tessera-git-conflict-none-'));

  try {
    assert.equal(await detectGitConflictOperation(root), null);
    assert.equal(
      await detectGitConflictOperation(path.join(root, 'does-not-exist')),
      null,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
