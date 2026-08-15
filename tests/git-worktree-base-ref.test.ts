import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { getWorktreeBaseRef } from '../src/lib/git/git-panel';

const execFileAsync = promisify(execFile);

const BASES_ARGS = ['config', '--local', '--get-regexp', '^branch\\..*\\.base$'];

test('picks the base recorded for this branch', () => {
  const raw = [
    'branch.feature/other.base refs/remotes/origin/dev',
    'branch.feature/mine.base refs/heads/feature/parent',
  ].join('\n');
  assert.equal(getWorktreeBaseRef(raw, 'feature/mine'), 'refs/heads/feature/parent');
});

test('a branch with no recorded base answers null rather than a neighbour’s', () => {
  const raw = 'branch.feature/other.base refs/remotes/origin/dev';
  assert.equal(getWorktreeBaseRef(raw, 'feature/mine'), null);
  assert.equal(getWorktreeBaseRef(null, 'feature/mine'), null);
  assert.equal(getWorktreeBaseRef(raw, null), null);
});

test('a branch name carrying dots stays one name', () => {
  // `branch.a.b.base` is ambiguous to anything that splits on dots; matching the
  // key whole keeps `a.b` from reading as branch `a` with a subkey.
  const raw = [
    'branch.a.base refs/remotes/origin/main',
    'branch.a.b.base refs/remotes/origin/dev',
  ].join('\n');
  assert.equal(getWorktreeBaseRef(raw, 'a.b'), 'refs/remotes/origin/dev');
  assert.equal(getWorktreeBaseRef(raw, 'a'), 'refs/remotes/origin/main');
});

test('the base survives the round trip through git config', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tessera-base-ref-'));
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

    const repo = path.join(root, 'repo');
    await git(['clone', remote, repo], root);
    await git(['commit', '--allow-empty', '-m', 'base'], repo);
    await git(['push', 'origin', 'main'], repo);

    // What the worktree creator does: cut the branch, then normalise the caller's
    // start point into the ref form the key stores.
    const worktree = path.join(root, 'wt');
    await git(['worktree', 'add', '-b', 'feature/child', '--', worktree, 'origin/main'], repo);
    const { stdout: normalised } = await git(
      ['rev-parse', '--verify', '--quiet', '--symbolic-full-name', '--end-of-options','origin/main'],
      repo,
    );
    assert.equal(normalised.trim(), 'refs/remotes/origin/main');
    await git(
      ['config', '--local', '--replace-all', 'branch.feature/child.base', normalised.trim()],
      repo,
    );

    // The panel reads from inside the linked worktree, where `--local` resolves
    // to the same common dir the creator wrote to.
    const { stdout: bases } = await git(BASES_ARGS, worktree);
    assert.equal(getWorktreeBaseRef(bases, 'feature/child'), 'refs/remotes/origin/main');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a start point given as a commit normalises to no ref', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tessera-base-sha-'));
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
    const repo = path.join(root, 'repo');
    await git(['init', '-b', 'main', repo], root);
    await git(['commit', '--allow-empty', '-m', 'base'], repo);
    const { stdout: sha } = await git(['rev-parse', 'HEAD'], repo);

    // `--symbolic-full-name` prints nothing for a raw commit. The creator writes
    // no key at all in that case: a base naming no ref is worse than none.
    const { stdout } = await git(
      ['rev-parse', '--verify', '--quiet', '--symbolic-full-name', '--end-of-options',sha.trim()],
      repo,
    );
    assert.equal(stdout.trim(), '');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
