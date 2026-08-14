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
const tabItemSource = fs.readFileSync(
  new URL('../src/components/tab/tab-item.tsx', import.meta.url),
  'utf8',
);

test('project header keeps an explicit drag lane around its view controls', () => {
  assert.match(appHeaderSource, /const isLinuxElectron = electronPlatform === 'linux'/);
  assert.match(appHeaderSource, /isMacElectron \|\| isWindowsElectron \|\| isLinuxElectron/);
  assert.match(appHeaderSource, /className="electron-drag absolute inset-0"/);
  assert.match(appHeaderSource, /data-testid="app-header-drag-surface"/);
  assert.match(appHeaderSource, /isElectronTitlebar && 'pointer-events-none self-stretch'/);
  assert.match(appHeaderSource, /isElectronTitlebar && 'min-w-12 self-stretch'/);
  assert.match(appHeaderSource, /electron-no-drag pointer-events-auto/);
  assert.match(appHeaderSource, /data-testid="app-header-drag-lane"/);
  assert.match(appHeaderSource, /<ProjectViewModeToggle[\s\S]*labelMode="short"/);
  assert.doesNotMatch(appHeaderSource, /projectDisplayName|projectInitial|getProjectColor/);
});

test('tab bar empty spacer remains an explicit Electron drag region', () => {
  assert.match(tabBarSource, /const isLinuxElectron = electronPlatform === 'linux'/);
  assert.match(tabBarSource, /isLinuxElectron && 'electron-drag h-\[40px\]/);
  assert.match(tabBarSource, /'electron-drag transition-colors'/);
  assert.match(tabBarSource, /electronPlatform && 'min-w-12'/);
  // The spacer gives its width to the tab list control on a phone (#247), but never in
  // Electron: a frameless titlebar with no drag region is a window that cannot be moved.
  assert.match(tabBarSource, /isPhoneViewport && !electronPlatform \? 'w-0 shrink-0' : 'flex-1'/);
  assert.match(tabBarSource, /data-testid="tab-bar-new-tab-drop-zone"/);
  assert.doesNotMatch(tabBarSource, /data-testid="tab-bar-end-zone"/);
});

test('scroll viewport owns the tab no-drag region instead of offscreen tabs', () => {
  assert.match(
    tabBarSource,
    /className="electron-no-drag flex min-w-0 items-stretch overflow-x-auto scroll-px-8 scrollbar-none"/,
  );
  assert.doesNotMatch(
    tabItemSource,
    /'electron-no-drag relative flex h-\[calc\(100%\+1px\)\]/,
  );
});
