import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const composerSource = fs.readFileSync(
  new URL('../src/components/chat/terminal-chat-composer.tsx', import.meta.url),
  'utf8',
);

test('terminal Chat View accepts every path drop supported by the direct PTY', () => {
  assert.match(composerSource, /isNativeFileDrag\(dataTransfer\) \|\| hasWorkspaceFileDragData\(dataTransfer\)/);
  assert.match(composerSource, /getNativeFileDropAbsolutePaths\(event\.dataTransfer\)/);
  assert.match(composerSource, /getWorkspaceFileDragAbsolutePath\(event\.dataTransfer\)/);
  assert.match(composerSource, /onDrop=\{handleDrop\}/);
  assert.match(composerSource, /insertTerminalChatPathsAtCursor\(currentValue, cursorPos, paths\)/);
});

test('terminal Chat View uploads image-only paste and inserts the returned path', () => {
  assert.match(
    composerSource,
    /clipboardData\.getData\('text\/plain'\)\) return;[\s\S]*attachImages\(imageFiles\)/,
  );
  assert.match(
    composerSource,
    /insertPaths\(await Promise\.all\(imageFiles\.map\(uploadTerminalClipboardFile\)\)\)/,
  );
  assert.match(composerSource, /onPaste=\{handlePaste\}/);
});

test('terminal Chat View exposes the shared image picker on phones only', () => {
  assert.match(composerSource, /accept=\{TERMINAL_IMAGE_FILE_ACCEPT\}/);
  assert.match(composerSource, /onChange=\{handleImageSelect\}/);
  assert.match(composerSource, /data-testid="terminal-chat-composer-attach-image"/);
  assert.match(composerSource, /hidden shrink-0[\s\S]*max-sm:flex/);
  assert.match(composerSource, /void attachImages\(\[file\]\)/);
});
