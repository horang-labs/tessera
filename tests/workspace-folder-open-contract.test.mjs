import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const filePanelSource = fs.readFileSync(
  new URL('../src/components/workspace/workspace-file-panel.tsx', import.meta.url),
  'utf8',
);

test('workspace folder rows expose the Electron open path context menu', () => {
  const directoryBranchStart = filePanelSource.indexOf('if (node.type === "directory")');
  const fileBranchStart = filePanelSource.indexOf('const isSelected = node.path === selectedPath');
  assert.notEqual(directoryBranchStart, -1);
  assert.notEqual(fileBranchStart, -1);

  const directoryBranch = filePanelSource.slice(directoryBranchStart, fileBranchStart);
  assert.match(directoryBranch, /const absolutePath = toAbsoluteWorkspacePath\(workDir, node\.path\);/);
  assert.match(directoryBranch, /onContextMenu=\{\(event\) => \{/);
  assert.match(directoryBranch, /event\.preventDefault\(\);/);
  assert.match(directoryBranch, /setContextMenu\(\{\s*absolutePath,\s*canOpenFile: true,/);
});
