import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  removeStaleGitTempPacks,
  STALE_GIT_TEMP_FILE_AGE_MS,
} from '@/lib/git/git-temp-pack-cleanup';

async function gitDirWithPacks(files: Record<string, number>): Promise<{
  gitDir: string;
  packDir: string;
  cleanup: () => Promise<void>;
}> {
  const root = await mkdtemp(path.join(tmpdir(), 'tessera-temp-pack-'));
  const gitDir = path.join(root, '.git');
  const packDir = path.join(gitDir, 'objects', 'pack');
  await mkdir(packDir, { recursive: true });
  for (const [name, mtimeMs] of Object.entries(files)) {
    const filePath = path.join(packDir, name);
    await writeFile(filePath, 'x'.repeat(10));
    await utimes(filePath, mtimeMs / 1000, mtimeMs / 1000);
  }
  return { gitDir, packDir, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test('temporary packs abandoned by a killed fetch are removed, real packs are not', async () => {
  const now = Date.now();
  const old = now - STALE_GIT_TEMP_FILE_AGE_MS - 1_000;
  const { gitDir, packDir, cleanup } = await gitDirWithPacks({
    tmp_pack_abc123: old,
    tmp_idx_def456: old,
    'pack-0123.pack': old,
    'pack-0123.idx': old,
  });
  try {
    const result = await removeStaleGitTempPacks(gitDir, 'native', now);

    assert.deepEqual(result, { removedFiles: 2, removedBytes: 20 });
    assert.deepEqual((await readdir(packDir)).sort(), ['pack-0123.idx', 'pack-0123.pack']);
  } finally {
    await cleanup();
  }
});

test('a temporary pack still being written is left alone', async () => {
  // A fetch the user is running in a terminal writes into its tmp_pack
  // continuously; its modification time is what keeps it safe.
  const now = Date.now();
  const { gitDir, packDir, cleanup } = await gitDirWithPacks({
    tmp_pack_live: now - 5_000,
  });
  try {
    const result = await removeStaleGitTempPacks(gitDir, 'native', now);

    assert.deepEqual(result, { removedFiles: 0, removedBytes: 0 });
    assert.deepEqual(await readdir(packDir), ['tmp_pack_live']);
  } finally {
    await cleanup();
  }
});

test('a Git directory without a pack directory is not an error', async () => {
  const result = await removeStaleGitTempPacks('/nonexistent/repo/.git', 'native');
  assert.deepEqual(result, { removedFiles: 0, removedBytes: 0 });
});
