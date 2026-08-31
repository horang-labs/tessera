import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const codeViewSource = readFileSync(
  new URL('../src/components/workspace/workspace-code-view.tsx', import.meta.url),
  'utf8',
);
const fileTabSource = readFileSync(
  new URL('../src/components/workspace/workspace-file-tab.tsx', import.meta.url),
  'utf8',
);

test('workspace images render before the generic binary fallback', () => {
  const imageBranch = codeViewSource.indexOf('imageRawUrl && fileData');
  const binaryFallback = codeViewSource.indexOf('fileData?.binary && !isImageFile');
  assert.notEqual(imageBranch, -1);
  assert.notEqual(binaryFallback, -1);
  assert.match(codeViewSource, /buildWorkspaceRawFileUrl\(sourceTarget, path, `\$\{fileData\.mtimeMs\}-\$\{fileData\.size\}`\)/);
  assert.match(codeViewSource, /<WorkspaceImageViewer/);
});

test('workspace images, including textual SVG, are never editable', () => {
  assert.match(fileTabSource, /!isWorkspaceImageMimeType\(fileData\.mimeType\)/);
});
