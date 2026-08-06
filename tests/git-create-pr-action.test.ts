import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { GitActionRejection, runCreatePullRequest } from '@/lib/git/git-actions';
import { createGitRunner, type GitRunner } from '@/lib/worktrees/git-runner';
import type { GhCommandResult } from '@/lib/github/gh-cli';
import type { AgentEnvironment } from '@/lib/settings/types';

const execFileAsync = promisify(execFile);

/**
 * 'wsl' is the environment that reaches a plain local `spawn` on every non-Windows
 * platform, including a server running inside WSL — 'native' there means *Windows*
 * binaries (spawn-cli-runtime.ts:175), which cannot see a distro-local temp repo.
 */
const LOCAL_ENVIRONMENT: AgentEnvironment = 'wsl';
const SKIP_ON_WINDOWS = process.platform === 'win32';

const PR_URL = 'https://github.com/horang-labs/tessera/pull/236';

interface GhCall {
  args: string[];
  cwd: string | undefined;
}

/**
 * GitHub is the one part of this action that cannot be stood up in a test, so it
 * is the one part that is faked. Git is real: the branch, the upstream and the
 * remote URL the action reads all come from a repository on disk.
 */
function fakeGh(replies: (args: string[]) => GhCommandResult) {
  const calls: GhCall[] = [];
  const runGh = async (
    args: string[],
    options: { cwd?: string } = {},
  ): Promise<GhCommandResult> => {
    calls.push({ args, cwd: options.cwd });
    return replies(args);
  };
  return { calls, runGh };
}

/** What `gh pr create` prints on success: the URL of the pull request, alone. */
function ghCreated(): GhCommandResult {
  return { exitCode: 0, stdout: `${PR_URL}\n`, stderr: '' };
}

function ghViewed(payload: Record<string, unknown>): GhCommandResult {
  return { exitCode: 0, stdout: JSON.stringify(payload), stderr: '' };
}

interface PrFixture {
  workDir: string;
  runGit: GitRunner;
}

/**
 * A repository whose branch is committed, pushed and tracking — the state the
 * ladder offers Create PR from. The remote is a real one for the push and is
 * then renamed to a GitHub URL, which is how the action recognizes it as one.
 */
async function withSyncedRepo(
  run: (fixture: PrFixture) => Promise<void>,
  options: { remoteUrl?: string | null } = {},
): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tessera-git-pr-'));
  const workDir = path.join(root, 'work');
  const remoteDir = path.join(root, 'remote.git');

  try {
    fs.mkdirSync(workDir);
    await execFileAsync('git', ['init', '--bare', '--initial-branch=main', remoteDir]);
    await execFileAsync('git', ['init', '--initial-branch=main'], { cwd: workDir });
    await execFileAsync('git', ['config', 'user.email', 'test@tessera.local'], { cwd: workDir });
    await execFileAsync('git', ['config', 'user.name', 'Tessera Test'], { cwd: workDir });
    await execFileAsync('git', ['config', 'commit.gpgsign', 'false'], { cwd: workDir });
    await execFileAsync('git', ['remote', 'add', 'origin', remoteDir], { cwd: workDir });
    fs.writeFileSync(path.join(workDir, 'seed.txt'), 'seed\n');
    await execFileAsync('git', ['add', '.'], { cwd: workDir });
    await execFileAsync('git', ['commit', '-m', 'seed'], { cwd: workDir });
    await execFileAsync('git', ['push', '--set-upstream', 'origin', 'main'], { cwd: workDir });

    const remoteUrl =
      options.remoteUrl === undefined
        ? 'git@github.com:horang-labs/tessera.git'
        : options.remoteUrl;
    if (remoteUrl === null) {
      await execFileAsync('git', ['remote', 'remove', 'origin'], { cwd: workDir });
    } else {
      await execFileAsync('git', ['remote', 'set-url', 'origin', remoteUrl], { cwd: workDir });
    }

    await run({ workDir, runGit: createGitRunner(LOCAL_ENVIRONMENT) });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('a synced branch gets a pull request, reported with the base GitHub used', async (t) => {
  if (SKIP_ON_WINDOWS) return t.skip('the local-spawn environment differs on Windows');

  await withSyncedRepo(async ({ workDir, runGit }) => {
    const gh = fakeGh((args) =>
      args[1] === 'create'
        ? ghCreated()
        // `dev`, not the fixture's `main`: the base is read back off the pull
        // request GitHub opened, never assumed from the local repository.
        : ghViewed({ number: 236, url: PR_URL, baseRefName: 'dev' }),
    );

    const result = await runCreatePullRequest(workDir, runGit, gh.runGh);

    assert.equal(result.ok, true, 'expected the pull request to be created');
    if (!result.ok || result.outcome.action !== 'create_pr') return;
    assert.equal(result.outcome.number, 236);
    assert.equal(result.outcome.url, PR_URL);
    assert.equal(result.outcome.baseBranch, 'dev');
    assert.equal(result.outcome.branch, 'main');

    const create = gh.calls[0]!;
    assert.deepEqual(create.args.slice(0, 2), ['pr', 'create']);
    assert.equal(create.cwd, workDir);
    // The head branch is stated rather than left to gh's working-directory
    // inference, and the repository is the one `origin` points at.
    assert.equal(create.args[create.args.indexOf('--head') + 1], 'main');
    assert.equal(
      create.args[create.args.indexOf('--repo') + 1],
      'horang-labs/tessera',
    );
  });
});

test('a repository whose remote is not GitHub says so instead of asking gh', async (t) => {
  if (SKIP_ON_WINDOWS) return t.skip('the local-spawn environment differs on Windows');

  await withSyncedRepo(
    async ({ workDir, runGit }) => {
      const gh = fakeGh(() => ghCreated());

      await assert.rejects(
        () => runCreatePullRequest(workDir, runGit, gh.runGh),
        (error: unknown) =>
          error instanceof GitActionRejection
          && error.code === 'not_github_remote'
          // "reports why instead of failing opaquely": the message names the
          // remote it looked at, not gh's exit code.
          && /origin/.test(error.message),
      );
      assert.equal(gh.calls.length, 0, 'gh should not run without a GitHub remote');
    },
    { remoteUrl: 'git@gitlab.com:horang-labs/tessera.git' },
  );
});

test('a branch that was never published is told to publish, not handed to gh', async (t) => {
  if (SKIP_ON_WINDOWS) return t.skip('the local-spawn environment differs on Windows');

  await withSyncedRepo(async ({ workDir, runGit }) => {
    await execFileAsync('git', ['checkout', '-b', 'unpublished'], { cwd: workDir });
    const gh = fakeGh(() => ghCreated());

    await assert.rejects(
      () => runCreatePullRequest(workDir, runGit, gh.runGh),
      (error: unknown) =>
        error instanceof GitActionRejection && error.code === 'no_upstream',
    );
    assert.equal(gh.calls.length, 0);
  });
});

test('a detached HEAD has no branch to open a pull request from', async (t) => {
  if (SKIP_ON_WINDOWS) return t.skip('the local-spawn environment differs on Windows');

  await withSyncedRepo(async ({ workDir, runGit }) => {
    await execFileAsync('git', ['checkout', '--detach'], { cwd: workDir });
    const gh = fakeGh(() => ghCreated());

    await assert.rejects(
      () => runCreatePullRequest(workDir, runGit, gh.runGh),
      (error: unknown) =>
        error instanceof GitActionRejection && error.code === 'detached_head',
    );
  });
});

test('a gh that is not installed is a spawn failure, not a generic one', async (t) => {
  if (SKIP_ON_WINDOWS) return t.skip('the local-spawn environment differs on Windows');

  await withSyncedRepo(async ({ workDir, runGit }) => {
    const gh = fakeGh(() => ({
      exitCode: null,
      stdout: '',
      stderr: 'spawn gh ENOENT',
    }));

    const result = await runCreatePullRequest(workDir, runGit, gh.runGh);

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.failure.kind, 'spawn_failed');
    assert.equal(result.failure.exitCode, null);
  });
});

test('a gh the runner had to kill is reported as a timeout, not as a missing binary', async (t) => {
  if (SKIP_ON_WINDOWS) return t.skip('the local-spawn environment differs on Windows');

  await withSyncedRepo(async ({ workDir, runGit }) => {
    // Both cases carry a null exit code; only `timedOut` separates "gh is not
    // installed" from "GitHub never answered", and they are fixed differently.
    const gh = fakeGh(() => ({
      exitCode: null,
      stdout: '',
      stderr: 'gh did not respond within 60000ms and was terminated',
      timedOut: true,
    }));

    const result = await runCreatePullRequest(workDir, runGit, gh.runGh);

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.failure.kind, 'timeout');
  });
});

test('a gh that is signed out is reported as authentication, not as a broken command', async (t) => {
  if (SKIP_ON_WINDOWS) return t.skip('the local-spawn environment differs on Windows');

  await withSyncedRepo(async ({ workDir, runGit }) => {
    const gh = fakeGh(() => ({
      exitCode: 4,
      stdout: '',
      stderr: 'To get started with GitHub CLI, please run: gh auth login',
    }));

    const result = await runCreatePullRequest(workDir, runGit, gh.runGh);

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.failure.kind, 'authentication');
    // ADR 0005: what gh said survives to the client intact.
    assert.match(result.failure.stderr, /gh auth login/);
  });
});

test('a pull request gh refuses to open comes back as a failure value', async (t) => {
  if (SKIP_ON_WINDOWS) return t.skip('the local-spawn environment differs on Windows');

  await withSyncedRepo(async ({ workDir, runGit }) => {
    const gh = fakeGh(() => ({
      exitCode: 1,
      stdout: '',
      stderr: 'a pull request for branch "main" into branch "dev" already exists',
    }));

    const result = await runCreatePullRequest(workDir, runGit, gh.runGh);

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.failure.kind, 'command_failed');
    assert.match(result.failure.message, /already exists/);
    assert.equal(result.failure.exitCode, 1);
  });
});

test('a pull request that was opened is not reported as failed because reading it back stumbled', async (t) => {
  if (SKIP_ON_WINDOWS) return t.skip('the local-spawn environment differs on Windows');

  await withSyncedRepo(async ({ workDir, runGit }) => {
    const gh = fakeGh((args) =>
      args[1] === 'create'
        ? ghCreated()
        : { exitCode: 1, stdout: '', stderr: 'could not read pull request' },
    );

    const result = await runCreatePullRequest(workDir, runGit, gh.runGh);

    assert.equal(result.ok, true, 'the pull request exists once gh exits zero');
    if (!result.ok || result.outcome.action !== 'create_pr') return;
    // What is still certainly true: the URL gh printed when it created it.
    assert.equal(result.outcome.url, PR_URL);
    assert.equal(result.outcome.number, null);
    assert.equal(result.outcome.baseBranch, null);
  });
});
