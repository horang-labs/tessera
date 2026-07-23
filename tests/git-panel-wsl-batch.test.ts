import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { buildGitBatchScript } from '../src/lib/git/git-panel';

const execFileAsync = promisify(execFile);

test('batched git probe preserves empty and NUL-delimited command output', async () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tessera-git-batch-'));
  try {
    await execFileAsync('git', ['init'], { cwd: repoDir });
    const unusualName = "odd ' name.txt";
    fs.writeFileSync(path.join(repoDir, unusualName), 'untracked\n');

    const script = buildGitBatchScript([
      { key: 'repoRoot', args: ['rev-parse', '--show-toplevel'] },
      {
        key: 'status',
        args: ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
      },
      { key: 'missingRemote', args: ['remote', 'get-url', "doesn't-exist"] },
    ]);
    const { stdout } = await execFileAsync('sh', ['-c', script], {
      cwd: repoDir,
      encoding: 'utf8',
    });

    const results = new Map(
      stdout.trimEnd().split('\n').map((line) => {
        const [key, encodedField] = line.split('\t');
        assert.ok(encodedField?.startsWith('b64:'));
        return [
          key,
          Buffer.from(encodedField.slice(4), 'base64').toString('utf8'),
        ] as const;
      }),
    );

    assert.equal(results.get('repoRoot')?.trim(), repoDir);
    assert.match(results.get('status') ?? '', /odd ' name\.txt\0/);
    assert.equal(results.get('missingRemote'), '');
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test('batched git probe rejects keys that cannot be used as frame names', () => {
  assert.throws(
    () => buildGitBatchScript([{ key: '../escape', args: ['status'] }]),
    /Invalid git batch key/,
  );
});
