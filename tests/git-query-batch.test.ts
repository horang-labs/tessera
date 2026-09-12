import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { buildGitBatchScript, parseGitBatchOutput, runGitQueryBatch } from '@/lib/worktrees/git-query-batch';
import { supportsGitShellBatch, GitCommandError } from '@/lib/worktrees/git-runner';
import { GitReadCache } from '@/lib/git/git-read-cache';

const commands = [{ key: 'branch', args: ['branch', '--show-current'] }];

test('shell capability follows the execution environment, including native Windows execution from WSL', () => {
  for (const platform of ['linux', 'darwin'] as const) {
    assert.equal(supportsGitShellBatch('native', platform, false), true);
    assert.equal(supportsGitShellBatch('wsl', platform, false), true);
  }
  assert.equal(supportsGitShellBatch('native', 'win32', false), false);
  assert.equal(supportsGitShellBatch('wsl', 'win32', false), true);
  assert.equal(supportsGitShellBatch('native', 'linux', true), false);
  assert.equal(supportsGitShellBatch('wsl', 'linux', true), true);
});

test('framing rejects omissions, duplicates, unexpected keys, invalid statuses and broken base64', () => {
  for (const raw of [
    '', 'branch\tb64:ADA=\nbranch\tb64:ADA=',
    'other\tb64:ADA=', 'branch\tb64:AHg=', 'branch\tb64:ADI1Ng==',
    'branch\tb64:###', 'branch\tb64:YQ', 'branch\tb64:ADA=\textra',
    'branch\tb64:bWFpbg==',
  ]) assert.throws(() => parseGitBatchOutput(raw, commands), GitCommandError);
  assert.throws(() => buildGitBatchScript([...commands, ...commands]), /Invalid git batch key/);
  assert.equal(parseGitBatchOutput('branch\tb64:ADE=', commands).get('branch')?.exitCode, 1);
  assert.equal(parseGitBatchOutput('branch\tb64:ADA=', commands).get('branch')?.exitCode, 0);
});

test('the real batch preserves quoting, Git exit status, empty output and NUL paths', async () => {
  const root = fs.mkdtempSync(path.join(process.cwd(), ".scratch-batch-한글 ' "));
  try {
    execFileSync('git', ['init', '-q'], { cwd: root });
    fs.writeFileSync(path.join(root, "한글 ' $(echo BAD).txt"), 'test\n');
    const probes = [
      { key: 'files', args: ['ls-files', '--others', '--exclude-standard', '-z'] },
      { key: 'missing', args: ['remote', 'get-url', "absent ' remote"] },
      { key: 'empty', args: ['remote'] },
    ];
    const result = await runGitQueryBatch(probes, root, 'wsl', { timeoutMs: 5000 });
    assert.equal(result.get('files')?.stdout, execFileSync('git', probes[0].args, { cwd: root, encoding: 'utf8' }));
    assert.notEqual(result.get('missing')?.exitCode, 0);
    assert.equal(result.get('empty')?.stdout, '');
    assert.equal(result.get('empty')?.exitCode, 0);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('output limits fail the batch and a subsequent higher-limit read retries', async () => {
  const root = fs.mkdtempSync(path.join(process.cwd(), '.scratch-batch-cap-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: root });
    const reads = new GitReadCache<unknown>(250);
    let calls = 0;
    const query = (limit: number) => reads.read('test-key', () => {
      calls++;
      return runGitQueryBatch(commands, root, 'wsl', { maxOutputBytes: limit, timeoutMs: 5000 });
    });
    await assert.rejects(query(1), /exceeded its limit/);
    await query(1024);
    assert.equal(calls, 2);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a hung Git query times out and does not poison subsequent attempts', async () => {
  const root = fs.mkdtempSync(path.join(process.cwd(), '.scratch-batch-timeout-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['config', 'alias.wait', '!sleep 30'], { cwd: root });
    const before = fs.readdirSync(root);
    await assert.rejects(runGitQueryBatch([{ key: 'wait', args: ['wait'] }], root, 'wsl', { timeoutMs: 100 }),
      (error: unknown) => error instanceof GitCommandError && error.kind === 'timeout');
    assert.equal((await runGitQueryBatch(commands, root, 'wsl', { timeoutMs: 5000 })).size, 1);
    assert.deepEqual(fs.readdirSync(root), before);
    assert.doesNotMatch(buildGitBatchScript(commands), /mktemp|batch_dir/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

 test('short result caching expires and rejected concurrent promises can retry', async (t) => {
  let now = 1000;
  t.mock.method(Date, 'now', () => now);
  const cache = new GitReadCache<number>(250);
  let calls = 0;
  const read = () => cache.read('same-options', async () => ++calls);
  assert.deepEqual(await Promise.all([read(), read()]), [1, 1]);
  now += 249;
  assert.equal(await read(), 1);
  now += 1;
  assert.equal(await read(), 2);
  let failures = 0;
  const fail = () => cache.read('failure', async () => { failures++; throw new Error('retry'); });
  const results = await Promise.allSettled([fail(), fail()]);
  assert.ok(results.every((result) => result.status === 'rejected'));
  assert.equal(failures, 1);
  assert.equal(await cache.read('failure', async () => 3), 3);
});
