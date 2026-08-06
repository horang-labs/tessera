import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import {
  createGitRunner,
  createGitShellRunner,
  DEFAULT_GIT_TIMEOUT_MS,
  GitCommandError,
} from '@/lib/worktrees/git-runner';
import type { AgentEnvironment } from '@/lib/settings/types';

const execFileAsync = promisify(execFile);

/**
 * 'wsl' is the environment that reaches a plain local `spawn` on every non-Windows
 * platform, including a server running inside WSL — 'native' there means *Windows*
 * binaries (spawn-cli-runtime.ts:175), which cannot see a distro-local temp repo.
 */
const LOCAL_ENVIRONMENT: AgentEnvironment = 'wsl';
const SKIP_ON_WINDOWS = process.platform === 'win32';

async function withTempRepo<T>(run: (repoDir: string) => Promise<T>): Promise<T> {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tessera-git-runner-'));
  try {
    await execFileAsync('git', ['init'], { cwd: repoDir });
    return await run(repoDir);
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
}

test('a failing command carries its exit code and stderr, not a generic message', async (t) => {
  if (SKIP_ON_WINDOWS) return t.skip('the local-spawn environment differs on Windows');

  await withTempRepo(async (repoDir) => {
    const runGit = createGitRunner(LOCAL_ENVIRONMENT, { timeoutMs: 10_000 });
    const error = await runGit(['rev-parse', '--verify', 'refs/heads/nope'], { cwd: repoDir })
      .then(() => null, (caught: unknown) => caught);

    assert.ok(error instanceof GitCommandError, 'expected a GitCommandError');
    assert.equal(error.exitCode, 128);
    assert.ok(error.stderr.length > 0, 'stderr must survive the failure');
    assert.equal(error.message, error.stderr);
  });
});

test('authentication and not-found are promoted out of a generic failure', async (t) => {
  if (SKIP_ON_WINDOWS) return t.skip('the local-spawn environment differs on Windows');

  const runShell = createGitShellRunner(LOCAL_ENVIRONMENT, { timeoutMs: 10_000 });
  const kindOf = async (stderr: string): Promise<GitCommandError> => {
    const error = await runShell(`echo ${JSON.stringify(stderr)} >&2; exit 128`)
      .then(() => null, (caught: unknown) => caught);
    assert.ok(error instanceof GitCommandError);
    return error;
  };

  assert.equal(
    (await kindOf("fatal: Authentication failed for 'https://github.com/o/r.git'")).kind,
    'authentication',
  );
  assert.equal(
    (await kindOf('git@github.com: Permission denied (publickey).')).kind,
    'authentication',
  );
  assert.equal((await kindOf('remote: Repository not found.')).kind, 'not_found');
  assert.equal(
    (await kindOf("fatal: couldn't find remote ref refs/heads/gone")).kind,
    'not_found',
  );

  const generic = await kindOf('fatal: your branch is behind and cannot be fast-forwarded');
  assert.equal(generic.kind, 'command_failed');
  assert.equal(generic.exitCode, 128);

  // Windows says "Access is denied" when a file is locked; a `worktree remove`
  // losing to an open handle is not a credential problem.
  assert.equal(
    (await kindOf("fatal: cannot remove: Access is denied. (os error 5)")).kind,
    'command_failed',
  );
});

test('a hook saying no is promoted out of a generic command failure', async (t) => {
  if (SKIP_ON_WINDOWS) return t.skip('the local-spawn environment differs on Windows');

  const runShell = createGitShellRunner(LOCAL_ENVIRONMENT, { timeoutMs: 10_000 });
  const kindOf = async (stderr: string): Promise<GitCommandError> => {
    const error = await runShell(`echo ${JSON.stringify(stderr)} >&2; exit 1`)
      .then(() => null, (caught: unknown) => caught);
    assert.ok(error instanceof GitCommandError);
    return error;
  };

  // Git redirects hook output to stderr, so what a rejecting hook said is what
  // there is to classify by — the runners name themselves.
  assert.equal(
    (await kindOf('husky - pre-commit script failed')).kind,
    'hook_rejected',
  );
  assert.equal((await kindOf('lefthook: pre-push hook failed')).kind, 'hook_rejected');
  assert.equal(
    (await kindOf('remote: error: hook declined to update refs/heads/main')).kind,
    'hook_rejected',
  );

  // A hook rejection is the user's code being refused. A credential problem and
  // a missing ref are the tool failing, and stay where they were.
  assert.equal(
    (await kindOf('fatal: Authentication failed for pre-commit-hooks.example')).kind,
    'authentication',
  );
  assert.equal(
    (await kindOf('error: gpg failed to sign the data\nfatal: failed to write commit object')).kind,
    'command_failed',
  );

  // Git speaking in its own voice outranks a hook name that happens to appear
  // in the text — a hook file is also just a path Git can fail to read.
  assert.equal(
    (await kindOf("fatal: cannot open '.husky/pre-commit': Permission denied")).kind,
    'command_failed',
  );
  // `remote:` is the server echoing its hook, not a Git diagnostic prefix.
  assert.equal(
    (await kindOf('remote: error: hook declined to update refs/heads/main')).kind,
    'hook_rejected',
  );

  // A real push rejection, verbatim. Git always signs off with an `error:` line
  // of its own, so the hook's verdict has to be read line by line — judging the
  // whole of stderr would let that last line bury the refusal above it.
  const pushRejection = [
    'remote: policy: no direct pushes',
    'To /srv/repo.git',
    ' ! [remote rejected] main -> main (pre-receive hook declined)',
    "error: failed to push some refs to '/srv/repo.git'",
  ].join('\n');
  assert.equal((await kindOf(pushRejection)).kind, 'hook_rejected');

  // Git lists offending paths on their own indented lines, with no prefix of
  // its own to give them away. A hook file in that list is a path Git is
  // reporting, not a hook that said anything.
  const blockedByLocalChanges = [
    'error: Your local changes to the following files would be overwritten by merge:',
    '\t.husky/pre-commit',
    'Please commit your changes or stash them before you merge.',
  ].join('\n');
  assert.equal((await kindOf(blockedByLocalChanges)).kind, 'command_failed');
});

test('the default timeout clears the slowest legitimate command by a wide margin', () => {
  // `worktree add` on a large repository runs for minutes and had no deadline
  // before the merge; a tight default would turn a slow success into a failure.
  assert.ok(
    DEFAULT_GIT_TIMEOUT_MS >= 600_000,
    `default of ${DEFAULT_GIT_TIMEOUT_MS}ms is short enough to kill a real worktree add`,
  );
});

test('a hung command is terminated at the timeout, taking wedged children with it', async (t) => {
  if (SKIP_ON_WINDOWS) return t.skip('the local-spawn environment differs on Windows');

  const runShell = createGitShellRunner(LOCAL_ENVIRONMENT, { timeoutMs: 400 });
  const markerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tessera-git-timeout-'));
  const marker = path.join(markerDir, 'grandchild-survived');

  try {
    const startedAt = Date.now();
    // The inner `sh` outlives its parent and holds the stdout pipe open — the
    // case a plain `child.kill()` misses, and why the runner kills the group.
    const error = await runShell(`sh -c 'sleep 5; touch ${marker}' & wait`)
      .then(() => null, (caught: unknown) => caught);

    assert.ok(error instanceof GitCommandError);
    assert.equal(error.kind, 'timeout');
    assert.ok(
      Date.now() - startedAt < 3_000,
      'the runner must not wait out the wedged grandchild',
    );

    await new Promise((resolve) => setTimeout(resolve, 1_500));
    assert.equal(
      fs.existsSync(marker),
      false,
      'the grandchild kept running after its parent was killed',
    );
  } finally {
    fs.rmSync(markerDir, { recursive: true, force: true });
  }
});

test('output past the cap is dropped rather than buffered', async (t) => {
  if (SKIP_ON_WINDOWS) return t.skip('the local-spawn environment differs on Windows');

  const runShell = createGitShellRunner(LOCAL_ENVIRONMENT, {
    timeoutMs: 10_000,
    maxOutputBytes: 512,
  });
  const result = await runShell(`awk 'BEGIN { while (i++ < 5000) print "0123456789" }'`);

  assert.equal(result.truncated, true);
  assert.ok(
    result.stdout.length <= 512,
    `expected the cap to hold, got ${result.stdout.length} bytes`,
  );
});

test('a caller watching stdout can stop the command early and keep what arrived', async (t) => {
  if (SKIP_ON_WINDOWS) return t.skip('the local-spawn environment differs on Windows');

  const runShell = createGitShellRunner(LOCAL_ENVIRONMENT, { timeoutMs: 10_000 });
  const startedAt = Date.now();
  const result = await runShell('echo first; sleep 5; echo second');

  assert.equal(result.stoppedEarly, false, 'sanity: nothing asked it to stop');
  assert.match(result.stdout, /second/);
  assert.ok(Date.now() - startedAt >= 4_000);

  const stopped = await runShell('echo first; sleep 5; echo second', {
    onStdout: () => 'stop',
  });
  assert.equal(stopped.stoppedEarly, true);
  assert.match(stopped.stdout, /first/);
  assert.doesNotMatch(stopped.stdout, /second/);
});

test('stdout keeps its leading column, which git status encodes meaning in', async (t) => {
  if (SKIP_ON_WINDOWS) return t.skip('the local-spawn environment differs on Windows');

  await withTempRepo(async (repoDir) => {
    fs.writeFileSync(path.join(repoDir, 'tracked.txt'), 'one\n');
    await execFileAsync('git', ['add', 'tracked.txt'], { cwd: repoDir });
    await execFileAsync('git', ['-c', 'user.email=t@e.st', '-c', 'user.name=t', 'commit', '-m', 'init'], { cwd: repoDir });
    fs.writeFileSync(path.join(repoDir, 'tracked.txt'), 'two\n');

    const runGit = createGitRunner(LOCAL_ENVIRONMENT, { timeoutMs: 10_000 });
    const { stdout } = await runGit(
      ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
      { cwd: repoDir },
    );

    // " M tracked.txt": trimming the front would shift the status columns and
    // the panel would read the file as added rather than modified.
    assert.ok(stdout.startsWith(' M tracked.txt'), `got ${JSON.stringify(stdout)}`);
  });
});

test('a successful command reports its exit code and no truncation', async (t) => {
  if (SKIP_ON_WINDOWS) return t.skip('the local-spawn environment differs on Windows');

  await withTempRepo(async (repoDir) => {
    const runGit = createGitRunner(LOCAL_ENVIRONMENT, { timeoutMs: 10_000 });
    const result = await runGit(['rev-parse', '--is-inside-work-tree'], { cwd: repoDir });

    assert.equal(result.stdout, 'true');
    assert.equal(result.exitCode, 0);
    assert.equal(result.truncated, false);
    assert.equal(result.stoppedEarly, false);
  });
});

test('a command that never starts keeps the spawn errno preflight reads', async (t) => {
  if (SKIP_ON_WINDOWS) return t.skip('the local-spawn environment differs on Windows');

  const runGit = createGitRunner(LOCAL_ENVIRONMENT, { timeoutMs: 10_000 });
  const error = await runGit(['--version'], { cwd: '/definitely/not/a/directory' })
    .then(() => null, (caught: unknown) => caught);

  assert.ok(error instanceof GitCommandError);
  assert.equal(error.kind, 'spawn_failed');
  // `checkManagedWorktreePreflight` tells "Git is not installed" from "Git said
  // no" by reading this, so the errno has to survive being wrapped.
  assert.equal(error.code, 'ENOENT');
});

test('the Git panel spawns nothing itself — every Git command goes through the runner', () => {
  const source = fs.readFileSync(
    new URL('../src/lib/git/git-panel.ts', import.meta.url),
    'utf8',
  );

  assert.doesNotMatch(source, /\bspawnCli\b/);
  assert.doesNotMatch(source, /from ["']child_process["']/);
  assert.match(source, /createGitRunner/);
  assert.match(source, /createGitShellRunner/);
});
