import assert from 'node:assert/strict';
import test from 'node:test';

import { buildWorkspacePathContextMenuState } from '@/lib/workspace-files/workspace-context-menu-state';

test('a workspace folder context menu retains its absolute host path and pointer position', () => {
  const folder = { type: 'directory' as const, path: 'docs', name: 'docs' };
  assert.deepEqual(
    buildWorkspacePathContextMenuState({
      absolutePath: '/workspace/docs',
      canOpenFile: true,
      node: folder,
      x: 320,
      y: 180,
    }),
    {
      absolutePath: '/workspace/docs',
      canOpenFile: true,
      node: folder,
      position: { x: 320, y: 180 },
    },
  );
});

test('a workspace context menu fails closed without an absolute host path', () => {
  assert.equal(
    buildWorkspacePathContextMenuState({
      absolutePath: null,
      canOpenFile: false,
      node: null,
      x: 1,
      y: 2,
    }),
    null,
  );
});
