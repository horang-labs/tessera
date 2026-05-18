import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const popoutSource = fs.readFileSync(
  new URL('../src/components/board/board-popout-layout.tsx', import.meta.url),
  'utf8',
);
const themeInitializerSource = fs.readFileSync(
  new URL('../src/components/theme-initializer.tsx', import.meta.url),
  'utf8',
);
const settingsStoreSource = fs.readFileSync(
  new URL('../src/stores/settings-store.ts', import.meta.url),
  'utf8',
);

test('board popout loads user settings so the saved theme is applied', () => {
  assert.match(popoutSource, /import \{ useSettingsStore \} from '@\/stores\/settings-store';/);
  assert.match(popoutSource, /const loadSettings = useSettingsStore\(\(state\) => state\.load\);/);
  assert.match(
    popoutSource,
    /useEffect\(function loadUserSettingsInPopout\(\) \{\s*void loadSettings\(\);\s*\}, \[loadSettings\]\);/,
  );
});

test('theme initializer rehydrates settings changed by another window', () => {
  assert.match(settingsStoreSource, /export const SETTINGS_STORAGE_KEY = 'tessera:settings';/);
  assert.match(themeInitializerSource, /function handlePersistedSettingsChange\(event: StorageEvent\)/);
  assert.match(themeInitializerSource, /void useSettingsStore\.persist\.rehydrate\(\);/);
  assert.match(themeInitializerSource, /window\.addEventListener\('storage', handlePersistedSettingsChange\);/);
});

test('settings changes broadcast to already-open popout windows', () => {
  assert.match(settingsStoreSource, /export const SETTINGS_SYNC_CHANNEL = 'tessera:settings-sync';/);
  assert.match(settingsStoreSource, /function broadcastSettingsSnapshot\(settings: UserSettings\)/);
  assert.match(settingsStoreSource, /broadcastSettingsSnapshot\(updated\);/);
  assert.match(settingsStoreSource, /applyExternalSettings: \(settings: UserSettings\) => void;/);
  assert.match(themeInitializerSource, /new window\.BroadcastChannel\(SETTINGS_SYNC_CHANNEL\)/);
  assert.match(themeInitializerSource, /function handleSettingsBroadcast\(event: MessageEvent<unknown>\)/);
  assert.match(themeInitializerSource, /applyExternalSettings\(event\.data\.settings\);/);
});
