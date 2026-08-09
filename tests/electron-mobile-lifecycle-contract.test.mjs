import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const mainSource = fs.readFileSync(new URL('../electron/main.ts', import.meta.url), 'utf8');
const closeDialogSource = fs.readFileSync(
  new URL('../src/components/layout/electron-close-dialog.tsx', import.meta.url),
  'utf8',
);
const remoteAccessSectionSource = fs.readFileSync(
  new URL('../src/components/settings/remote-access-section.tsx', import.meta.url),
  'utf8',
);

function sourceBetween(source, start, end) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(startIndex, -1, `missing start marker: ${start}`);
  assert.notEqual(endIndex, -1, `missing end marker: ${end}`);
  return source.slice(startIndex, endIndex);
}

test('tray close hides the window without entering the quit path', () => {
  const applyCloseAction = sourceBetween(
    mainSource,
    'function applyWindowCloseAction',
    'function forceKillProcessTree',
  );

  assert.match(
    applyCloseAction,
    /if \(action === 'quit'\) \{\n\s+requestAppQuit\(\);\n\s+\} else if \(action === 'tray'\) \{\n\s+win\.hide\(\);/,
  );
  assert.doesNotMatch(applyCloseAction, /stopServer\(|app\.quit\(\)/);
});

test('saved quit preference still enters the confirmed application quit path', () => {
  assert.match(
    closeDialogSource,
    /savedBehavior === 'quit' \|\| savedBehavior === 'tray'[\s\S]*respondWindowClose\?\.\(payload\.requestId, savedBehavior\)/,
  );
  assert.match(mainSource, /if \(action === 'quit'\) \{\n\s+requestAppQuit\(\);/);
  assert.match(
    mainSource,
    /if \(!\(await confirmAppQuit\(summary\.activeCount\)\)\) return;[\s\S]*app\.quit\(\);/,
  );
});

test('cancelling quit leaves the application and local server running', () => {
  const beginQuit = sourceBetween(mainSource, 'async function beginAppQuit', 'function requestAppQuit');
  const cancelIndex = beginQuit.indexOf('if (!(await confirmAppQuit(summary.activeCount))) return;');

  assert.notEqual(cancelIndex, -1);
  assert.ok(cancelIndex < beginQuit.indexOf('isQuitRequested = true;'));
  assert.ok(cancelIndex < beginQuit.indexOf('app.quit();'));
  assert.doesNotMatch(beginQuit.slice(0, cancelIndex), /stopServer\(/);
});

test('normal quit stops only the local server and preserves Mobile Connection identity', () => {
  const quitCleanup = sourceBetween(mainSource, "app.on('will-quit'", "app.on('window-all-closed'");

  assert.match(quitCleanup, /await stopServer\(\)/);
  assert.doesNotMatch(quitCleanup, /mobileAccessCoordinator|configureServe|stateStore/);
});

test('Mobile Connection Setup preserves close preference and does not enable login startup', () => {
  const setupHandler = sourceBetween(
    remoteAccessSectionSource,
    'const handleMobileAccessSetup',
    'const handleMobileAccessExternalAction',
  );

  assert.doesNotMatch(setupHandler, /windowsCloseBehavior|updateSettings/);
  assert.doesNotMatch(
    `${mainSource}\n${remoteAccessSectionSource}`,
    /setLoginItemSettings|openAtLogin/,
  );
});
