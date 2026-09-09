import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildWorkspaceRawFileUrl,
  inferWorkspaceFileContentType,
  isWorkspaceImageMimeType,
} from '../src/lib/workspace-files/workspace-file-preview';

test('infers supported workspace image MIME types', () => {
  const cases = new Map([
    ['preview.avif', 'image/avif'],
    ['preview.bmp', 'image/bmp'],
    ['preview.gif', 'image/gif'],
    ['preview.ico', 'image/x-icon'],
    ['preview.jpeg', 'image/jpeg'],
    ['preview.JPG', 'image/jpeg'],
    ['preview.png', 'image/png'],
    ['preview.svg', 'image/svg+xml'],
    ['preview.webp', 'image/webp'],
    ['assets#draft/preview.png', 'image/png'],
    ['shot#1.PNG', 'image/png'],
    ['what?/preview.webp', 'image/webp'],
  ]);

  for (const [filePath, mimeType] of cases) {
    assert.equal(inferWorkspaceFileContentType(filePath), mimeType);
    assert.equal(isWorkspaceImageMimeType(mimeType), true);
  }
  assert.equal(inferWorkspaceFileContentType('archive.zip'), 'application/octet-stream');
  assert.equal(isWorkspaceImageMimeType('application/octet-stream'), false);
});

test('builds versioned raw URLs for session and worktree targets', () => {
  assert.equal(
    buildWorkspaceRawFileUrl({ kind: 'session', id: 'session/id' }, 'images/a b.png', '12-34'),
    '/api/sessions/session%2Fid/file?path=images%2Fa%20b.png&raw=1&v=12-34',
  );
  assert.equal(
    buildWorkspaceRawFileUrl({ kind: 'worktree', id: 'worktree id' }, 'icon.svg'),
    '/api/worktrees/worktree%20id/file?path=icon.svg&raw=1',
  );
});
