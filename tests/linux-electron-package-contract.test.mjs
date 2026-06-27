import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const packageJson = JSON.parse(
  fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
);
const afterPackSource = fs.readFileSync(
  new URL('../scripts/electron-after-pack.cjs', import.meta.url),
  'utf8',
);
const electronMainSource = fs.readFileSync(
  new URL('../electron/main.ts', import.meta.url),
  'utf8',
);
const electronPreloadSource = fs.readFileSync(
  new URL('../electron/preload.ts', import.meta.url),
  'utf8',
);
const windowControlsSource = fs.readFileSync(
  new URL('../src/components/layout/electron-window-controls.tsx', import.meta.url),
  'utf8',
);
const electronTitlebarSource = fs.readFileSync(
  new URL('../src/components/layout/electron-titlebar.tsx', import.meta.url),
  'utf8',
);
const debAfterInstallSource = fs.readFileSync(
  new URL('../scripts/linux-deb-after-install.tpl', import.meta.url),
  'utf8',
);

test('Linux Electron package does not disable the Chromium sandbox by default', () => {
  assert.doesNotMatch(packageJson.scripts['electron:dev'], /--no-sandbox/);
  assert.ok(!packageJson.build.linux.executableArgs);
  assert.doesNotMatch(afterPackSource, /--no-sandbox/);
});

test('Linux deb packaging relies on electron-builder chrome-sandbox installation', () => {
  assert.equal(packageJson.build.linux.executableName, 'tessera');
  assert.equal(packageJson.build.directories.app, '.electron-runtime');
  assert.equal(packageJson.build.afterPack, 'scripts/electron-after-pack.cjs');
  assert.equal(packageJson.build.deb.afterInstall, 'scripts/linux-deb-after-install.tpl');
  assert.match(debAfterInstallSource, /chown root:root '\/opt\/\$\{sanitizedProductName\}\/chrome-sandbox'/);
  assert.match(debAfterInstallSource, /chmod 4755 '\/opt\/\$\{sanitizedProductName\}\/chrome-sandbox'/);
  assert.match(debAfterInstallSource, /update-alternatives --install/);
});

test('Linux Electron windows use a custom frameless titlebar', () => {
  assert.match(electronMainSource, /const isLinux = process\.platform === 'linux'/);
  assert.match(electronMainSource, /frame: !isLinux/);
  assert.match(electronPreloadSource, /controlWindow: \(action: 'minimize' \| 'toggle-maximize' \| 'close'\)/);
  assert.match(electronMainSource, /ipcMain\.handle\('window-control'/);
  assert.match(windowControlsSource, /electronPlatform !== 'linux'/);
  assert.match(windowControlsSource, /data-testid="electron-window-controls"/);
  assert.match(electronTitlebarSource, /platform === 'win32' \|\| platform === 'linux'/);
});
