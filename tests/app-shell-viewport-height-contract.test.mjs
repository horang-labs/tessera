import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const srcRoot = new URL('../src/', import.meta.url).pathname;

// `100vh` measures the viewport with the mobile URL bar retracted, so a shell sized
// to it overflows the visible area and the page itself scrolls. Repro pages under
// src/app/dev-* are test surfaces, not production paths, and are excluded.
// `min-h-screen` is excluded too: login, setup and pairing are pages that should be
// free to grow taller than the viewport and scroll normally.
const FULL_VIEWPORT_HEIGHT = /(?<!min-)\bh-screen\b|100vh/;
const SCANNED_EXTENSIONS = new Set(['.ts', '.tsx', '.css']);

function productionSourceFiles(directory = srcRoot) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name.startsWith('dev-')) continue;
      files.push(...productionSourceFiles(entryPath));
      continue;
    }
    if (SCANNED_EXTENSIONS.has(path.extname(entry.name))) files.push(entryPath);
  }
  return files;
}

test('no production path sizes itself to the static viewport height', () => {
  const offenders = [];
  for (const file of productionSourceFiles()) {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, index) => {
      if (!FULL_VIEWPORT_HEIGHT.test(line)) return;
      offenders.push(`${path.relative(srcRoot, file)}:${index + 1}: ${line.trim()}`);
    });
  }

  assert.deepEqual(
    offenders,
    [],
    `production code must size itself to the dynamic viewport height:\n${offenders.join('\n')}`,
  );
});

test('the app shell fills the dynamic viewport height', () => {
  const chatLayout = fs.readFileSync(path.join(srcRoot, 'components/chat/chat-layout.tsx'), 'utf8');
  const boardPopout = fs.readFileSync(
    path.join(srcRoot, 'components/board/board-popout-layout.tsx'),
    'utf8',
  );

  assert.match(chatLayout, /className="flex h-dvh flex-col overflow-hidden"/);
  assert.match(boardPopout, /className="flex h-dvh flex-col overflow-hidden bg-\(--board-bg\)"/);
});

test('the add-project dialog is capped by the dynamic viewport height', () => {
  const folderBrowser = fs.readFileSync(
    path.join(srcRoot, 'components/chat/folder-browser-dialog.tsx'),
    'utf8',
  );

  assert.match(folderBrowser, /maxHeight: 'calc\(100dvh - 2rem\)'/);
  // The width was already clamped correctly and is not part of this change.
  assert.match(folderBrowser, /maxWidth: 'calc\(100vw - 2rem\)'/);
});

test('the viewport meta lets the soft keyboard shrink the layout viewport', () => {
  const rootLayout = fs.readFileSync(path.join(srcRoot, 'app/layout.tsx'), 'utf8');

  assert.match(rootLayout, /export const viewport: Viewport = \{/);
  assert.match(rootLayout, /interactiveWidget: 'resizes-content',/);
});
