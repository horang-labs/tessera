import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { getDefaultBranchName } from '../src/lib/git/git-panel';

const execFileAsync = promisify(execFile);

const DEFAULT_BRANCH_ARGS = [
  'for-each-ref',
  '--format=%(refname) %(symref)',
  'refs/remotes/*/HEAD',
];

test('reads the default branch from a remote that is not called origin', () => {
  const raw = 'refs/remotes/upstream/HEAD refs/remotes/upstream/main';
  assert.equal(getDefaultBranchName(raw, 'upstream'), 'main');
});

test('prefers origin when the clone has several remotes', () => {
  // Git lists remotes alphabetically, so the first line is not the answer here.
  const raw = [
    'refs/remotes/fork/HEAD refs/remotes/fork/wip',
    'refs/remotes/origin/HEAD refs/remotes/origin/dev',
  ].join('\n');
  assert.equal(getDefaultBranchName(raw, 'fork\norigin'), 'dev');
});

test('falls back to Git’s own order when there is no origin', () => {
  const raw = [
    'refs/remotes/alpha/HEAD refs/remotes/alpha/trunk',
    'refs/remotes/beta/HEAD refs/remotes/beta/main',
  ].join('\n');
  // The remote list decides, not the line order: `git remote` puts beta first
  // only if that is how this clone is configured.
  assert.equal(getDefaultBranchName(raw, 'beta\nalpha'), 'main');
});

test('still answers when the remote list failed to read', () => {
  const raw = 'refs/remotes/upstream/HEAD refs/remotes/upstream/main';
  assert.equal(getDefaultBranchName(raw, null), 'main');
});

test('ignores a remote HEAD that is not a symbolic ref', () => {
  // `for-each-ref` prints the ref with an empty second field; it names no branch.
  assert.equal(getDefaultBranchName('refs/remotes/origin/HEAD ', 'origin'), null);
  assert.equal(getDefaultBranchName('', 'origin'), null);
  assert.equal(getDefaultBranchName(null, 'origin'), null);
});

test('the probe answers on a clone whose remote is not origin', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tessera-default-branch-'));
  const git = (args: string[], cwd: string) =>
    execFileAsync('git', args, {
      cwd,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 't',
        GIT_AUTHOR_EMAIL: 't@example.com',
        GIT_COMMITTER_NAME: 't',
        GIT_COMMITTER_EMAIL: 't@example.com',
      },
    });

  try {
    const remote = path.join(root, 'remote.git');
    await git(['init', '--bare', '-b', 'main', remote], root);

    const seed = path.join(root, 'seed');
    await git(['clone', remote, seed], root);
    await git(['commit', '--allow-empty', '-m', 'base'], seed);
    await git(['push', 'origin', 'main'], seed);

    // The configuration this fix is about: `origin` never exists here, so the
    // old `symbolic-ref refs/remotes/origin/HEAD` exited non-zero and the panel
    // reported no default branch at all.
    const clone = path.join(root, 'clone');
    await git(['clone', '-o', 'upstream', remote, clone], root);

    const { stdout: heads } = await git(DEFAULT_BRANCH_ARGS, clone);
    const { stdout: remotes } = await git(['remote'], clone);

    assert.equal(getDefaultBranchName(heads, remotes), 'main');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
