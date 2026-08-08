import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const appHeaderSource = fs.readFileSync(
  new URL('../src/components/layout/app-header.tsx', import.meta.url),
  'utf8',
);
const tabBarSource = fs.readFileSync(
  new URL('../src/components/tab/tab-bar.tsx', import.meta.url),
  'utf8',
);

test('project header static content remains draggable in Electron titlebars', () => {
  assert.match(appHeaderSource, /const isLinuxElectron = electronPlatform === 'linux'/);
  assert.match(appHeaderSource, /isMacElectron \|\| isWindowsElectron \|\| isLinuxElectron/);
  assert.match(appHeaderSource, /isElectronTitlebar && 'electron-drag pointer-events-none'/);
});

test('tab bar empty spacer remains an explicit Electron drag region', () => {
  assert.match(tabBarSource, /const isLinuxElectron = electronPlatform === 'linux'/);
  assert.match(tabBarSource, /isLinuxElectron && 'electron-drag h-\[40px\]/);
  assert.match(tabBarSource, /'electron-drag transition-colors'/);
  // The spacer gives its width to the tab list control on a phone (#247), but never in
  // Electron: a frameless titlebar with no drag region is a window that cannot be moved.
  assert.match(tabBarSource, /isPhoneViewport && !electronPlatform \? 'w-0 shrink-0' : 'flex-1'/);
  assert.match(tabBarSource, /data-testid="tab-bar-new-tab-drop-zone"/);
});
