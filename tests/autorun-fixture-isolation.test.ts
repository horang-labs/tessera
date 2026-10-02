import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import test from 'node:test';
import { autorunFixture } from './autorun-fixture';

const execute = promisify(execFile);

test('standalone runtime and Autorun tests leave the inherited host data directory untouched', async () => {
  await fs.mkdir('tmp', { recursive: true });
  const dir = await fs.mkdtemp(path.resolve('tmp/autorun-host-sentinel-'));
  await fs.writeFile(path.join(dir, 'sentinel'), 'Keep this host data.');
  try {
    const env = { ...process.env, TESSERA_DATA_DIR: dir };
    delete env.NODE_TEST_CONTEXT;
    const result = await execute(process.execPath, ['--import', 'tsx', '--test',
      'tests/automation-runtime.test.ts', 'tests/automation-launch.test.ts', 'tests/autorun-engine.test.ts'],
    { env, timeout: 30_000, maxBuffer: 1024 * 1024 });
    assert.match(result.stdout, /# tests [1-9]\d*/);
    assert.match(result.stdout, /continue atomically links one immutable proposal/);
    assert.deepEqual(await fs.readdir(dir), ['sentinel']);
    assert.equal(await fs.readFile(path.join(dir, 'sentinel'), 'utf8'), 'Keep this host data.');
  } finally { await fs.rm(dir, { recursive: true }); }
});

test('sequential Autorun fixtures own separate directories and restore the inherited environment', async () => {
  const previous = process.env.TESSERA_DATA_DIR;
  const directories: string[] = [];
  try {
    for (let i = 0; i < 2; i++) {
      const f = await autorunFixture();
      const owned = process.env.TESSERA_DATA_DIR;
      try {
        assert.ok(owned && owned !== previous);
        assert.ok(!directories.includes(owned));
        directories.push(owned);
        assert.ok((await fs.stat(owned)).isDirectory());
      } finally { await f.close(); }
      assert.equal(process.env.TESSERA_DATA_DIR, previous);
      await assert.rejects(fs.stat(owned!), { code: 'ENOENT' });
    }
  } finally {
    if (previous === undefined) delete process.env.TESSERA_DATA_DIR;
    else process.env.TESSERA_DATA_DIR = previous;
  }
});
