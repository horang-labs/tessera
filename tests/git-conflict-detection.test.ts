import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { isBridgedAgentEnvironment } from '@/lib/filesystem/path-environment';
import {
  detectGitConflictOperation,
  resolveWorktreeGitDir,
} from '@/lib/git/git-conflict-state';
import type { AgentEnvironment } from '@/lib/settings/types';

const execFileAsync = promisify(execFile);

/**
 * The environment that is *not* bridged on a Linux/WSL host, so a distro-local
 * temp repository is read exactly where it sits. `native` here means Windows,
 * which cannot see one.
 */
const LOCAL_ENVIRONMENT: AgentEnvironment = 'wsl';
const SKIP_ON_WINDOWS = process.platform === 'win32';

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

    assert.equal(await detectGitConflictOperation(repoDir, LOCAL_ENVIRONMENT), 'merge');
  });
});

test('a worktree stopped mid-rebase reports a rebase', async () => {
  await withDivergedRepo(async (repoDir) => {
    await runExpectingConflict(['rebase', 'other'], repoDir);

    // A rebase replays commits the way a cherry-pick does, so the answer that
    // matters is the one that names the abort which puts this worktree back.
    assert.equal(await detectGitConflictOperation(repoDir, LOCAL_ENVIRONMENT), 'rebase');
  });
});

test('a worktree stopped mid-cherry-pick reports a cherry-pick', async () => {
  await withDivergedRepo(async (repoDir) => {
    await runExpectingConflict(['cherry-pick', 'other'], repoDir);

    assert.equal(await detectGitConflictOperation(repoDir, LOCAL_ENVIRONMENT), 'cherry_pick');
  });
});

test('a worktree with nothing in progress reports no conflict', async () => {
  await withDivergedRepo(async (repoDir) => {
    assert.equal(await detectGitConflictOperation(repoDir, LOCAL_ENVIRONMENT), null);
  });
});

test('a finished operation stops being reported', async () => {
  await withDivergedRepo(async (repoDir) => {
    await runExpectingConflict(['rebase', 'other'], repoDir);
    await execFileAsync('git', ['rebase', '--abort'], { cwd: repoDir });

    // `REBASE_HEAD` survives the abort, which is why it is not what the probe
    // reads: a worktree that reported a rebase forever could never be committed
    // in again.
    assert.equal(await detectGitConflictOperation(repoDir, LOCAL_ENVIRONMENT), null);
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
    assert.equal(await detectGitConflictOperation(linkedDir, LOCAL_ENVIRONMENT), 'merge');
    // And the main checkout, which merged nothing, still says so.
    assert.equal(await detectGitConflictOperation(repoDir, LOCAL_ENVIRONMENT), null);
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
      assert.equal(await detectGitConflictOperation(repoDir, LOCAL_ENVIRONMENT), 'merge');
    } finally {
      process.env.PATH = originalPath;
    }
  });
});

/**
 * The bridge CLAUDE.md warns about, in the direction this host can actually
 * stand up: a server inside WSL with a native (Windows) agent, which
 * `isBridgedAgentEnvironment('native')` reports true for here. Git then names
 * the repository `C:\...`, and nothing under that path is openable from this
 * process until it is translated.
 *
 * Skipped rather than faked anywhere the bridge does not exist — a translation
 * asserted against a stub is the code's own answer read back.
 */
const WINDOWS_DRIVE_ROOT = '/mnt/c/Users/work';
const BRIDGED_NATIVE = !SKIP_ON_WINDOWS
  && isBridgedAgentEnvironment('native')
  && fs.existsSync(WINDOWS_DRIVE_ROOT);

test(
  'a repository the agent names by drive letter is probed where the server can reach it',
  { skip: !BRIDGED_NATIVE },
  async () => {
    const repoDir = fs.mkdtempSync(path.join(WINDOWS_DRIVE_ROOT, 'tessera-t238-'));
    // What a Windows Git reports for that same directory — the form the panel
    // and the abort both hand this module on a native bridge.
    const agentReportedPath = `C:\\${path.relative('/mnt/c', repoDir).replace(/\//g, '\\')}`;

    try {
      await execFileAsync('git', ['init', '-q', '--initial-branch=main', repoDir]);
      await configureIdentity(repoDir);
      fs.writeFileSync(path.join(repoDir, 'file.txt'), 'base\n');
      await execFileAsync('git', ['add', '.'], { cwd: repoDir });
      await execFileAsync('git', ['commit', '-m', 'base'], { cwd: repoDir });
      await execFileAsync('git', ['checkout', '-qb', 'other'], { cwd: repoDir });
      fs.writeFileSync(path.join(repoDir, 'file.txt'), 'other\n');
      await execFileAsync('git', ['commit', '-qam', 'other'], { cwd: repoDir });
      await execFileAsync('git', ['checkout', '-q', 'main'], { cwd: repoDir });
      fs.writeFileSync(path.join(repoDir, 'file.txt'), 'main\n');
      await execFileAsync('git', ['commit', '-qam', 'main'], { cwd: repoDir });
      await runExpectingConflict(['merge', 'other'], repoDir);

      assert.equal(
        await detectGitConflictOperation(agentReportedPath, 'native'),
        'merge',
      );
      // And the setting is what decides, not the shape of the path: read as a
      // path on this filesystem, `C:\...` is nowhere.
      assert.equal(await detectGitConflictOperation(agentReportedPath, 'wsl'), null);
    } finally {
      fs.rmSync(repoDir, { recursive: true, force: true });
    }
  },
);

test('a gitdir written relative to the worktree is resolved against it', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tessera-git-gitdir-'));

  try {
    fs.writeFileSync(
      path.join(root, '.git'),
      'gitdir: ../repo/.git/worktrees/feature\n',
    );
    const gitDir = await resolveWorktreeGitDir(root, LOCAL_ENVIRONMENT);

    assert.equal(gitDir, path.resolve(root, '../repo/.git/worktrees/feature'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a directory that is not a repository reports no conflict rather than throwing', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tessera-git-conflict-none-'));

  try {
    assert.equal(await detectGitConflictOperation(root, LOCAL_ENVIRONMENT), null);
    assert.equal(
      await detectGitConflictOperation(
        path.join(root, 'does-not-exist'),
        LOCAL_ENVIRONMENT,
      ),
      null,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
