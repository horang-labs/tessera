import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import {
  executeGitAction,
  GitActionRejection,
  type GitActionTarget,
} from '@/lib/git/git-actions';
import type { AgentEnvironment } from '@/lib/settings/types';

const execFileAsync = promisify(execFile);

/**
 * 'wsl' is the environment that reaches a plain local `spawn` on every non-Windows
 * platform, including a server running inside WSL — 'native' there means *Windows*
 * binaries (spawn-cli-runtime.ts:175), which cannot see a distro-local temp repo.
 */
const LOCAL_ENVIRONMENT: AgentEnvironment = 'wsl';
const SKIP_ON_WINDOWS = process.platform === 'win32';

interface PullFixture {
  target: GitActionTarget;
  repoDir: string;
  /** A second checkout of the same remote, used to move the upstream ahead. */
  otherDir: string;
}

async function configureIdentity(cwd: string, name: string): Promise<void> {
  await execFileAsync('git', ['config', 'user.email', `${name}@tessera.local`], { cwd });
  await execFileAsync('git', ['config', 'user.name', name], { cwd });
  await execFileAsync('git', ['config', 'commit.gpgsign', 'false'], { cwd });
}

/**
 * A tracking branch with a real bare remote and a second checkout behind it. The
 * remote is real so a pull is a real pull — what lands in the worktree is the
 * thing under test, and a fake would be the code's own answer read back.
 *
 * `pull.rebase` and `pull.ff` are deliberately left unset: that is the
 * configuration Git 2.27+ refuses a divergent pull under, and it is what most
 * machines actually have.
 */
async function withTrackingRepo(
  run: (fixture: PullFixture) => Promise<void>,
  options: { setUpstream?: boolean } = {},
): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tessera-git-pull-'));
  const repoDir = path.join(root, 'work');
  const otherDir = path.join(root, 'other');
  const remoteDir = path.join(root, 'remote.git');

  try {
    await execFileAsync('git', ['init', '--bare', '--initial-branch=main', remoteDir]);
    await execFileAsync('git', ['init', '--initial-branch=main', repoDir]);
    await configureIdentity(repoDir, 'Tessera');
    await execFileAsync('git', ['remote', 'add', 'origin', remoteDir], { cwd: repoDir });
    fs.writeFileSync(path.join(repoDir, 'seed.txt'), 'seed\n');
    await execFileAsync('git', ['add', '.'], { cwd: repoDir });
    await execFileAsync('git', ['commit', '-m', 'seed'], { cwd: repoDir });
    await execFileAsync('git', ['push', '--set-upstream', 'origin', 'main'], { cwd: repoDir });

    await execFileAsync('git', ['clone', remoteDir, otherDir]);
    await configureIdentity(otherDir, 'Other');

    if (options.setUpstream === false) {
      // The branch exists and the remote does; only the tracking link is gone.
      await execFileAsync('git', ['branch', '--unset-upstream'], { cwd: repoDir });
    }

    await run({
      target: { workDir: repoDir, agentEnvironment: LOCAL_ENVIRONMENT },
      repoDir,
      otherDir,
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

/** Moves the upstream on, so the repository under test is behind by one. */
async function advanceUpstream(otherDir: string, fileName: string): Promise<void> {
  fs.writeFileSync(path.join(otherDir, fileName), `${fileName}\n`);
  await execFileAsync('git', ['add', '.'], { cwd: otherDir });
  await execFileAsync('git', ['commit', '-m', `their ${fileName}`], { cwd: otherDir });
  await execFileAsync('git', ['push'], { cwd: otherDir });
}

/** Commits locally, so the branch is ahead as well as behind. */
async function commitLocally(
  repoDir: string,
  fileName: string,
  contents: string,
): Promise<void> {
  fs.writeFileSync(path.join(repoDir, fileName), contents);
  await execFileAsync('git', ['add', '.'], { cwd: repoDir });
  await execFileAsync('git', ['commit', '-m', `ours ${fileName}`], { cwd: repoDir });
}

test('a branch that is behind catches its worktree up', async (t) => {
  if (SKIP_ON_WINDOWS) return t.skip('the local-spawn environment differs on Windows');

  await withTrackingRepo(async ({ target, otherDir, repoDir }) => {
    await advanceUpstream(otherDir, 'theirs.txt');

    const result = await executeGitAction(target, { action: 'pull' });

    assert.equal(result.ok, true, 'expected the pull to succeed');
    if (!result.ok) return;
    assert.equal(result.outcome.action, 'pull');
    // The point of the action: the commits are in the working directory, not
    // merely fetched into a remote-tracking ref.
    assert.equal(fs.existsSync(path.join(repoDir, 'theirs.txt')), true);
    assert.equal(result.outcome.branch, 'main');
    assert.equal(result.outcome.upstream, 'origin/main');
  });
});

test('a branch with no upstream is refused before a pull runs', async (t) => {
  if (SKIP_ON_WINDOWS) return t.skip('the local-spawn environment differs on Windows');

  await withTrackingRepo(
    async ({ target }) => {
      await assert.rejects(
        () => executeGitAction(target, { action: 'pull' }),
        (error: unknown) =>
          error instanceof GitActionRejection && error.code === 'no_upstream',
      );
    },
    { setUpstream: false },
  );
});

test('a detached HEAD is refused rather than pulled into whatever it resolves to', async (t) => {
  if (SKIP_ON_WINDOWS) return t.skip('the local-spawn environment differs on Windows');

  await withTrackingRepo(async ({ target, repoDir }) => {
    await execFileAsync('git', ['checkout', '--detach'], { cwd: repoDir });

    await assert.rejects(
      () => executeGitAction(target, { action: 'pull' }),
      (error: unknown) =>
        error instanceof GitActionRejection && error.code === 'detached_head',
    );
  });
});

test('a branch that has diverged is still reconciled, not sent back for a policy', async (t) => {
  if (SKIP_ON_WINDOWS) return t.skip('the local-spawn environment differs on Windows');

  await withTrackingRepo(async ({ target, otherDir, repoDir }) => {
    await advanceUpstream(otherDir, 'theirs.txt');
    await commitLocally(repoDir, 'ours.txt', 'ours\n');

    const result = await executeGitAction(target, { action: 'pull' });

    // Git 2.27+ refuses a divergent pull outright when the repository pins no
    // reconciliation policy, and this fixture pins none. Reporting that refusal
    // would be a dead end: the same button pressed again fails identically.
    assert.equal(result.ok, true, 'expected the divergent pull to reconcile');
    assert.equal(fs.existsSync(path.join(repoDir, 'theirs.txt')), true);
    assert.equal(fs.existsSync(path.join(repoDir, 'ours.txt')), true);
  });
});

test('a pull that conflicts reports the Git error and leaves the tree to retry from', async (t) => {
  if (SKIP_ON_WINDOWS) return t.skip('the local-spawn environment differs on Windows');

  await withTrackingRepo(async ({ target, otherDir, repoDir }) => {
    // Both sides rewrite the same file, so the merge cannot be resolved for them.
    fs.writeFileSync(path.join(otherDir, 'seed.txt'), 'their line\n');
    await execFileAsync('git', ['commit', '--all', '-m', 'their edit'], { cwd: otherDir });
    await execFileAsync('git', ['push'], { cwd: otherDir });
    fs.writeFileSync(path.join(repoDir, 'seed.txt'), 'our line\n');
    await execFileAsync('git', ['commit', '--all', '-m', 'our edit'], { cwd: repoDir });

    const result = await executeGitAction(target, { action: 'pull' });

    assert.equal(result.ok, false, 'expected the pull to fail');
    if (result.ok) return;
    // ADR 0005: Git's own account of the failure survives to the client.
    assert.match(
      `${result.failure.message}\n${result.failure.stderr}`,
      /conflict|merge failed/i,
    );
    // And the change set it left behind, which is what the user retries from.
    assert.ok(
      result.failure.changedFiles.some((file) => file.path === 'seed.txt'),
      'expected the conflicted file to be reported',
    );
  });
});
