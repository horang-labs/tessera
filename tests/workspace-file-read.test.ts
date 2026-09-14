import assert from 'node:assert/strict';
import { mkdtemp, rm, truncate, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { readWorkspaceFileResponse, WorkspaceFileError } from '../src/lib/workspace-files/read-workspace-file';
import { MAX_RAW_FILE_BYTES } from '../src/lib/workspace-files/workspace-file-io';

test('workspace file metadata and raw responses share image MIME information', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'tessera-workspace-image-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 1, 2, 3]);
  await writeFile(path.join(root, 'preview.png'), bytes);

  const metadataResponse = await readWorkspaceFileResponse({
    raw: false,
    rawPath: 'preview.png',
    root,
    sourceId: 'session-1',
  });
  const metadata = await metadataResponse.json();
  assert.equal(metadata.mimeType, 'image/png');
  assert.equal(metadata.binary, true);
  assert.equal(metadata.content, '');

  const rawResponse = await readWorkspaceFileResponse({
    raw: true,
    rawPath: 'preview.png',
    root,
    sourceId: 'session-1',
  });
  assert.equal(rawResponse.headers.get('content-type'), 'image/png');
  assert.equal(rawResponse.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(Buffer.from(await rawResponse.arrayBuffer()), bytes);
});

test('text-form SVG metadata is still classified as an image preview', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'tessera-workspace-svg-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"></svg>');

  const response = await readWorkspaceFileResponse({
    raw: false,
    rawPath: 'icon.svg',
    root,
    sourceId: 'worktree-1',
  });
  const metadata = await response.json();
  assert.equal(metadata.mimeType, 'image/svg+xml');
  assert.equal(metadata.binary, false);
});

test('raw image previews retain the bounded file-size limit', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'tessera-workspace-large-image-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const filePath = path.join(root, 'large.png');
  await writeFile(filePath, '');
  await truncate(filePath, MAX_RAW_FILE_BYTES + 1);

  await assert.rejects(
    readWorkspaceFileResponse({
      raw: true,
      rawPath: 'large.png',
      root,
      sourceId: 'session-1',
    }),
    (error: unknown) => error instanceof WorkspaceFileError
      && error.code === 'file_too_large'
      && error.status === 413,
  );
});

test('MP4 raw previews stream complete and single-range responses without the image size limit', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'tessera-workspace-video-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bytes = Buffer.from('0123456789');
  await writeFile(path.join(root, 'movie.mp4'), bytes);

  const full = await readWorkspaceFileResponse({
    raw: true, rawPath: 'movie.mp4', root, sourceId: 'session-1',
  });
  assert.equal(full.status, 200);
  assert.equal(full.headers.get('content-type'), 'video/mp4');
  assert.equal(full.headers.get('accept-ranges'), 'bytes');
  assert.equal(full.headers.get('content-length'), '10');
  assert.deepEqual(Buffer.from(await full.arrayBuffer()), bytes);

  const bounded = await readWorkspaceFileResponse({
    raw: true, rawPath: 'movie.mp4', root, sourceId: 'session-1', rangeHeader: 'bytes=2-99',
  });
  assert.equal(bounded.status, 206);
  assert.equal(bounded.headers.get('content-range'), 'bytes 2-9/10');
  assert.equal(bounded.headers.get('content-length'), '8');
  assert.deepEqual(Buffer.from(await bounded.arrayBuffer()), Buffer.from('23456789'));

  const openEnded = await readWorkspaceFileResponse({
    raw: true, rawPath: 'movie.mp4', root, sourceId: 'session-1', rangeHeader: 'bytes=7-',
  });
  assert.equal(openEnded.headers.get('content-range'), 'bytes 7-9/10');
  assert.deepEqual(Buffer.from(await openEnded.arrayBuffer()), Buffer.from('789'));

  const suffix = await readWorkspaceFileResponse({
    raw: true, rawPath: 'movie.mp4', root, sourceId: 'session-1', rangeHeader: 'bytes=-3',
  });
  assert.equal(suffix.headers.get('content-range'), 'bytes 7-9/10');
  assert.deepEqual(Buffer.from(await suffix.arrayBuffer()), Buffer.from('789'));
});

test('MP4 raw previews ignore malformed or multi-ranges and reject unsatisfiable ranges', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'tessera-workspace-video-range-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'movie.mp4'), '0123456789');

  for (const rangeHeader of ['bytes=wat', 'bytes=0-1,4-5', 'items=0-1']) {
    const response = await readWorkspaceFileResponse({
      raw: true, rawPath: 'movie.mp4', root, sourceId: 'session-1', rangeHeader,
    });
    assert.equal(response.status, 200, rangeHeader);
    assert.equal(response.headers.get('content-range'), null, rangeHeader);
    assert.equal(Buffer.from(await response.arrayBuffer()).toString(), '0123456789', rangeHeader);
  }

  for (const rangeHeader of ['bytes=10-', 'bytes=-0', 'bytes=8-7']) {
    const response = await readWorkspaceFileResponse({
      raw: true, rawPath: 'movie.mp4', root, sourceId: 'session-1', rangeHeader,
    });
    assert.equal(response.status, 416, rangeHeader);
    assert.equal(response.headers.get('content-range'), 'bytes */10', rangeHeader);
  }
});

test('MP4 raw previews allow files larger than the image raw preview limit', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'tessera-workspace-large-video-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const filePath = path.join(root, 'large.mp4');
  await writeFile(filePath, 'x');
  await truncate(filePath, MAX_RAW_FILE_BYTES + 1);

  const response = await readWorkspaceFileResponse({
    raw: true, rawPath: 'large.mp4', root, sourceId: 'session-1', rangeHeader: 'bytes=0-0',
  });
  assert.equal(response.status, 206);
  assert.equal(response.headers.get('content-range'), `bytes 0-0/${MAX_RAW_FILE_BYTES + 1}`);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), Buffer.from('x'));
});

test('empty MP4 previews return an empty full response and reject byte ranges', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'tessera-workspace-empty-video-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'empty.mp4'), '');

  const full = await readWorkspaceFileResponse({
    raw: true, rawPath: 'empty.mp4', root, sourceId: 'session-1',
  });
  assert.equal(full.status, 200);
  assert.equal(full.headers.get('content-length'), '0');
  assert.equal(full.headers.get('accept-ranges'), 'bytes');
  assert.equal((await full.arrayBuffer()).byteLength, 0);

  const range = await readWorkspaceFileResponse({
    raw: true, rawPath: 'empty.mp4', root, sourceId: 'session-1', rangeHeader: 'bytes=0-',
  });
  assert.equal(range.status, 416);
  assert.equal(range.headers.get('content-range'), 'bytes */0');
});
