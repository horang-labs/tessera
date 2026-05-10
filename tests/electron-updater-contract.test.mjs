import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const packageJson = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const packageSource = fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8');
const preloadSource = fs.readFileSync(new URL('../electron/preload.ts', import.meta.url), 'utf8');
const updaterSource = fs.readFileSync(new URL('../electron/updater.ts', import.meta.url), 'utf8');
const mainSource = fs.readFileSync(new URL('../electron/main.ts', import.meta.url), 'utf8');
const updateStoreSource = fs.readFileSync(new URL('../src/stores/update-store.ts', import.meta.url), 'utf8');

test('desktop builds are configured for electron-updater release metadata', () => {
  assert.ok(packageJson.dependencies['electron-updater']);
  assert.equal(packageSource.match(/"electron-updater"/g)?.length, 1);
  assert.deepEqual(packageJson.build.publish, [
    {
      provider: 'github',
      owner: 'horang-labs',
      repo: 'tessera',
    },
  ]);
  assert.equal(packageJson.build.win.target, 'portable');
});

test('macOS auto-update builds include a universal zip update artifact', () => {
  assert.deepEqual(packageJson.build.mac.target, ['dmg', 'zip']);
  assert.match(
    packageJson.scripts['electron:build:mac:signed'],
    /electron-builder --mac dmg zip --universal/,
  );
  const workflow = fs.readFileSync(new URL('../.github/workflows/desktop-release.yml', import.meta.url), 'utf8');
  assert.match(workflow, /release\/Tessera-\*-macos-universal\.zip/);
  assert.match(workflow, /release\/latest-mac\.yml/);
  assert.match(workflow, /codesign --verify --deep --strict --verbose=2 "\$unzip_dir\/Tessera\.app"/);
  assert.match(workflow, /spctl --assess --type execute --verbose "\$unzip_dir\/Tessera\.app"/);
  assert.doesNotMatch(
    workflow,
    /matrix:\s*\n\s*include:\s*\n\s*- arch:/,
  );
});

test('preload exposes the desktop updater bridge', () => {
  for (const apiName of [
    'checkForDesktopUpdate',
    'downloadDesktopUpdate',
    'installDesktopUpdate',
    'onDesktopUpdateEvent',
  ]) {
    assert.match(preloadSource, new RegExp(`${apiName}:`));
  }
});

test('desktop updater result handling follows electron-updater support contracts', () => {
  assert.match(updaterSource, /result\?\.isUpdateAvailable === true/);
  assert.doesNotMatch(updaterSource, /isNewerVersion\(info\.version, app\.getVersion\(\)\)/);
  assert.match(updaterSource, /process\.platform === 'darwin'/);
  assert.match(updateStoreSource, /desktopStatus: 'unsupported'[\s\S]*isDesktopUpdaterAvailable: false/);
  assert.match(updateStoreSource, /isDesktopUpdaterAvailable: false[\s\S]*dismissedVersion: readDismissedVersion\(\)/);
});

test('desktop update installs bypass close-to-tray handling', () => {
  assert.match(mainSource, /let isInstallingUpdate = false/);
  assert.match(mainSource, /let updateInstallPreparation: Promise<void> \| null = null/);
  assert.match(mainSource, /async function prepareForUpdateInstall\(\): Promise<void>/);
  assert.match(mainSource, /if \(updateInstallPreparation\) return updateInstallPreparation/);
  assert.match(mainSource, /updateInstallPreparation = stopServer\(\)/);
  assert.doesNotMatch(mainSource, /app\.on\('before-quit-for-update'/);
  assert.match(mainSource, /if \(isInstallingUpdate\) return;[\s\S]*event\.preventDefault\(\)/);
  assert.match(updaterSource, /prepareForUpdateInstall: PrepareForUpdateInstall = async \(\) => \{\}/);
  assert.match(updaterSource, /await prepareForUpdateInstall\(\);[\s\S]*autoUpdater\.quitAndInstall\(false, true\)/);
});

test('desktop available events can build visible update info before a check result returns', () => {
  assert.match(updateStoreSource, /function buildDesktopInfoFromEvent/);
  assert.doesNotMatch(updateStoreSource, /latestVersion && currentInfo\s*\?/);
  assert.match(updateStoreSource, /updateAvailable: true/);
  assert.match(updateStoreSource, /currentVersion: currentInfo\?\.currentVersion \?\? ''/);
});
