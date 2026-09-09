import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

function read(relativePath) {
  return fs.readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8');
}

const imagePanelSource = read('src/components/image-generation/image-generations-panel.tsx');
const terminalPanelSource = read('src/components/terminal/terminal-panel.tsx');
const terminalChatSource = read('src/components/chat/terminal-chat-composer.tsx');
const panelWrapperSource = read('src/components/panel/panel-wrapper.tsx');

test('generated results expose a path-only drag without changing their click behavior', () => {
  assert.match(imagePanelSource, /draggable=\{Boolean\(result\.path\)\}/);
  assert.match(imagePanelSource, /setPathInsertDragData\(event\.dataTransfer, \[result\.path\]\)/);
  assert.match(imagePanelSource, /src=\{result\.url\}[\s\S]{0,120}draggable=\{false\}/);
  assert.match(imagePanelSource, /onClick=\{\(\) => onOpenImage/);
});

test('input thumbnails expose the same path-only drag without changing their click behavior', () => {
  assert.match(imagePanelSource, /draggable=\{Boolean\(input\.path\)\}/);
  assert.match(imagePanelSource, /setPathInsertDragData\(event\.dataTransfer, \[input\.path\]\)/);
  assert.match(imagePanelSource, /src=\{input\.url\}[\s\S]{0,120}draggable=\{false\}/);
  assert.match(imagePanelSource, /onClick=\{\(\) => onOpenImage\(\{ src: input\.url/);
});

test('every PTY prompt surface accepts the generated-image path drag contract', () => {
  for (const source of [terminalPanelSource, terminalChatSource, panelWrapperSource]) {
    assert.match(source, /hasPathInsertDragData/);
    assert.match(source, /getInternalPathDropPaths/);
  }
});
