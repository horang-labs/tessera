import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const electronMainSource = fs.readFileSync(
  new URL('../electron/main.ts', import.meta.url),
  'utf8',
);
const appSecretHeaderSource = fs.readFileSync(
  new URL('../electron/app-secret-header.ts', import.meta.url),
  'utf8',
);

test('Electron injects the app secret only for its four HTTP and WebSocket origins', () => {
  assert.doesNotMatch(appSecretHeaderSource, /^import .*app-secret';$/m);
  assert.match(
    appSecretHeaderSource,
    /await import\('\.\.\/src\/lib\/auth\/app-secret'\)/,
  );
  assert.match(appSecretHeaderSource, /readFile\(APP_SECRET_PATH, 'utf8'\)/);
  assert.match(appSecretHeaderSource, /defaultSession\.webRequest\.onBeforeSendHeaders/);
  assert.match(appSecretHeaderSource, /`http:\/\/localhost:\$\{port\}\/\*`/);
  assert.match(appSecretHeaderSource, /`http:\/\/127\.0\.0\.1:\$\{port\}\/\*`/);
  assert.match(appSecretHeaderSource, /`ws:\/\/localhost:\$\{port\}\/\*`/);
  assert.match(appSecretHeaderSource, /`ws:\/\/127\.0\.0\.1:\$\{port\}\/\*`/);
  assert.doesNotMatch(appSecretHeaderSource, /\*:\$\{port\}|:\*\//);
});

test('Electron installs header injection before creating any app window', () => {
  const registerIndex = electronMainSource.indexOf('await registerAppSecretHeader(port);');
  const createIndex = electronMainSource.indexOf(
    'mainWindow = createWindow(port, restoredLayout.main ?? undefined);',
  );

  assert.notEqual(registerIndex, -1);
  assert.notEqual(createIndex, -1);
  assert.ok(registerIndex < createIndex);
  assert.doesNotMatch(electronMainSource, /\bpartition\s*:/);
});
