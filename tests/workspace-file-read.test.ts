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
