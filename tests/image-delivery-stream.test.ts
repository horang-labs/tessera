import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { readTraceImageStream } from '@/lib/image-generation/session-traces';

const CHUNK = 64 * 1024;

test('file delivery pulls bounded chunks without prefetch and cancellation closes the stream', async () => {
  const directory = await fs.mkdtemp(path.join(process.cwd(), '.image-delivery-test-'));
  const filePath = path.join(directory, 'image.png');
  try {
    await fs.writeFile(filePath, Buffer.alloc(CHUNK * 3 + 7, 1));
    const image = await readTraceImageStream({ kind: 'cache', path: filePath }, '');
    assert.ok(image);
    // With no consumer there must be no prefetched image data.
    await new Promise(resolve => setTimeout(resolve, 10));
    const file = await fs.open(filePath, 'r+');
    await file.write(Buffer.from([9]), 0, 1, 0);
    await file.close();
    const reader = image.stream.getReader();
    const first = await reader.read();
    assert.equal(first.value?.byteLength, CHUNK);
    assert.equal(first.value?.[0], 9);
    await reader.cancel();
    assert.equal((await reader.read()).done, true);
    // On Windows this also proves the read handle no longer holds the file open.
    await fs.unlink(filePath);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('inline base64 delivery preserves bytes in chunks no larger than 64 KiB', async () => {
  const expected = Buffer.alloc(CHUNK * 3 + 13);
  for (let i = 0; i < expected.length; i++) expected[i] = i % 251;
  const data = expected.toString('base64').replace(/.{120}/g, '$&\n');
  const image = await readTraceImageStream({ kind: 'inline', data, mimeType: 'image/png' }, '');
  assert.ok(image);
  const reader = image.stream.getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    assert.ok(value.byteLength <= CHUNK);
    chunks.push(value);
  }
  assert.ok(chunks.length > 1);
  assert.deepEqual(Buffer.concat(chunks), expected);
});

test('request abort errors an unread stream and oversized or absent images are rejected', async () => {
  const directory = await fs.mkdtemp(path.join(process.cwd(), '.image-delivery-test-'));
  const filePath = path.join(directory, 'image.png');
  try {
    await fs.writeFile(filePath, 'image');
    const controller = new AbortController();
    const image = await readTraceImageStream({ kind: 'cache', path: filePath }, '', controller.signal);
    assert.ok(image);
    controller.abort(new Error('test abort'));
    await assert.rejects(image.stream.getReader().read(), /test abort/);
    const file = await fs.open(filePath, 'r+');
    await file.truncate(25 * 1024 * 1024 + 1);
    await file.close();
    assert.equal(await readTraceImageStream({ kind: 'cache', path: filePath }, ''), null);
    assert.equal(await readTraceImageStream({ kind: 'cache', path: path.join(directory, 'missing.png') }, ''), null);
    assert.equal(await readTraceImageStream({ kind: 'inline', data: '', mimeType: 'image/png' }, ''), null);
    const oversizedBase64 = 'A'.repeat(Math.ceil((25 * 1024 * 1024 + 1) / 3) * 4);
    assert.equal(await readTraceImageStream({ kind: 'inline', data: oversizedBase64, mimeType: 'image/png' }, ''), null);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
