import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { buildWorkspacePathContextMenuState } from '../src/lib/workspace-files/workspace-context-menu-state.ts';

const filePanelSource = fs.readFileSync(
  new URL('../src/components/workspace/workspace-file-panel.tsx', import.meta.url),
  'utf8',
);

test('workspace folder rows expose the Electron open path context menu', () => {
  const node = { type: 'directory', name: 'docs', path: 'docs' };
  assert.deepEqual(buildWorkspacePathContextMenuState({
    absolutePath: '/workspace/docs',
    canOpenFile: true,
    node,
    x: 20,
    y: 30,
  }), {
    absolutePath: '/workspace/docs',
    canOpenFile: true,
    node,
    position: { x: 20, y: 30 },
  });
  assert.match(filePanelSource, /onContextMenu=\{\(event\) => openRowContextMenu\(event, node, absolutePath\)\}/);
  assert.match(filePanelSource, /buildWorkspacePathContextMenuState/);
});
