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

test('every user-facing New Tab command reuses an existing pristine empty tab', () => {
  assert.equal(
    /function handleAddTab\(\) \{\s*useTabStore\.getState\(\)\.openNewTab\(\);/.test(tabBarSource),
    true,
    'the tab-bar + button must use openNewTab()',
  );
  assert.equal(
    /const handleNewTab = useCallback\(\(\) => \{\s*useTabStore\.getState\(\)\.openNewTab\(\);/.test(keyboardSource),
    true,
    'the New Tab keyboard shortcut must use openNewTab()',
  );
  assert.equal(
    /case 'new-tab':\s*useTabStore\.getState\(\)\.openNewTab\(\);/.test(titlebarSource),
    true,
    'the Electron titlebar command must use openNewTab()',
  );
});
