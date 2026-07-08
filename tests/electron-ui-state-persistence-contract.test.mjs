import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const electronMainSource = fs.readFileSync(
  new URL('../electron/main.ts', import.meta.url),
  'utf8',
);
const electronPreloadSource = fs.readFileSync(
  new URL('../electron/preload.ts', import.meta.url),
  'utf8',
);
const uiStorageSource = fs.readFileSync(
  new URL('../src/lib/persistence/ui-storage.ts', import.meta.url),
  'utf8',
);
const boardStoreSource = fs.readFileSync(
  new URL('../src/stores/board-store.ts', import.meta.url),
  'utf8',
);
const tabStoreSource = fs.readFileSync(
  new URL('../src/stores/tab-store.ts', import.meta.url),
  'utf8',
);

test('packaged Electron prefers a stable local server port', () => {
  assert.match(electronMainSource, /const ELECTRON_DEFAULT_PORT = 32123;/);
  assert.match(electronMainSource, /const ELECTRON_PORT_SCAN_LIMIT = 100;/);
  assert.match(electronMainSource, /async function findStablePort\(\): Promise<number>/);
  assert.match(electronMainSource, /const candidate = ELECTRON_DEFAULT_PORT \+ offset;/);
  assert.match(electronMainSource, /const port = await findStablePort\(\);/);
  assert.doesNotMatch(electronMainSource, /srv\.listen\(0, '127\.0\.0\.1'/);
});

test('Electron UI storage is persisted by main process outside the page origin', () => {
  assert.match(electronMainSource, /const UI_STORAGE_PATH = getTesseraDataPath\('ui-state\.json'\);/);
  assert.match(electronMainSource, /function readUiStorage\(\): Record<string, string>/);
  assert.match(electronMainSource, /function writeUiStorage\(state: Record<string, string>\): void/);
  assert.match(electronMainSource, /ipcMain\.on\('ui-storage-get-item'/);
  assert.match(electronMainSource, /ipcMain\.on\('ui-storage-set-item'/);
  assert.match(electronMainSource, /ipcMain\.on\('ui-storage-remove-item'/);
  assert.match(electronMainSource, /event\.returnValue = getUiStorageItem\(key\);/);
});

test('preload exposes synchronous UI storage methods for store bootstrap', () => {
  assert.match(electronPreloadSource, /uiStorageGetItem: \(key: string\) => ipcRenderer\.sendSync\('ui-storage-get-item', key\)/);
  assert.match(electronPreloadSource, /uiStorageSetItem: \(key: string, value: string\) =>/);
  assert.match(electronPreloadSource, /ipcRenderer\.sendSync\('ui-storage-set-item', \{ key, value \}\)/);
  assert.match(electronPreloadSource, /uiStorageRemoveItem: \(key: string\) =>/);
  assert.match(electronPreloadSource, /ipcRenderer\.sendSync\('ui-storage-remove-item', key\)/);
});

test('renderer persistence uses Electron storage before localStorage fallback', () => {
  assert.match(uiStorageSource, /electronApi\?\.isElectron && electronApi\.uiStorageGetItem/);
  assert.match(uiStorageSource, /electronApi\?\.isElectron && electronApi\.uiStorageSetItem/);
  assert.match(uiStorageSource, /electronApi\?\.isElectron && electronApi\.uiStorageRemoveItem/);
  assert.match(uiStorageSource, /window\.localStorage\.getItem\(key\)/);
  assert.match(uiStorageSource, /window\.localStorage\.setItem\(key, value\)/);
  assert.match(uiStorageSource, /window\.localStorage\.removeItem\(key\)/);
});

test('board and tab stores avoid direct origin-scoped localStorage access', () => {
  assert.match(boardStoreSource, /from '@\/lib\/persistence\/ui-storage';/);
  assert.match(tabStoreSource, /from '@\/lib\/persistence\/ui-storage';/);
  assert.doesNotMatch(boardStoreSource, /\blocalStorage\./);
  assert.doesNotMatch(tabStoreSource, /\blocalStorage\./);
  assert.match(tabStoreSource, /readUiStorageItem\(TAB_STORE_KEY\)/);
  assert.match(tabStoreSource, /writeUiStorageItem\(TAB_STORE_KEY, JSON\.stringify\(data\)\)/);
});
