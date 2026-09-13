import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { randomBytes } from 'node:crypto';

test('streams escaped transcript image spans and path files into the same content cache', async () => {
  const directory = await fs.mkdtemp(path.join(process.cwd(), '.image-stream-test-'));
  process.env.TESSERA_DATA_DIR = directory;
  try {
    const { cacheImageFile } = await import('@/lib/image-generation/cache-files');
    const bytes = randomBytes(2 * 1024 * 1024 + 7);
    const imagePath = path.join(directory, 'source.png');
    await fs.writeFile(imagePath, bytes);
    const encoded = JSON.stringify(`data:image/png;base64,${bytes.toString('base64')}`).slice(1, -1).replace(/\//g, '\\/').replace(/\+/g, '\\u002b');
    const prefix = '{"image_url":"';
    const transcriptPath = path.join(directory, 'rollout.jsonl');
    await fs.writeFile(transcriptPath, prefix + encoded + '"}\n');
    const fromSpan = await cacheImageFile('stream', { kind: 'transcript', path: transcriptPath,
      offset: Buffer.byteLength(prefix), length: Buffer.byteLength(encoded), dataUrl: true }, 'native');
    const fromPath = await cacheImageFile('stream', { kind: 'path', path: imagePath }, 'native');
    assert.deepEqual(fromSpan, fromPath);
    assert.equal(fromSpan?.kind, 'cache');
    if (fromSpan?.kind === 'cache') assert.deepEqual(await fs.readFile(fromSpan.path), bytes);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
