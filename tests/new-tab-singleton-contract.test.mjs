import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const tabBarSource = fs.readFileSync(
  new URL('../src/components/tab/tab-bar.tsx', import.meta.url),
  'utf8',
);
const keyboardSource = fs.readFileSync(
  new URL('../src/hooks/use-keyboard-shortcuts.ts', import.meta.url),
  'utf8',
);
const titlebarSource = fs.readFileSync(
  new URL('../src/components/layout/electron-titlebar.tsx', import.meta.url),
  'utf8',
);

test('every user-facing New Tab entry point routes through the shared command', () => {
  for (const [name, source] of [
    ['tab-bar + button', tabBarSource],
    ['keyboard shortcut', keyboardSource],
    ['Electron titlebar', titlebarSource],
  ]) {
    assert.match(source, /import \{ openSingletonNewTab \}/, `${name} must import the command`);
    assert.match(source, /openSingletonNewTab\(\);/, `${name} must invoke the command`);
  }
});
