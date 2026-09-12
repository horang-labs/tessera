import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(
  new URL('../src/components/workspace/workspace-file-panel.tsx', import.meta.url),
  'utf8',
);

test('worktree-backed Files rows remain draggable into panel split targets', () => {
  assert.match(source, /setWorkspaceTargetFileDragData/);
  assert.match(source, /if \(!target\) return;\s*setSelectedPath\(node\.path\);\s*setWorkspaceTargetFileDragData/);
  assert.match(source, /draggable=\{Boolean\(target\)\}/);
});
