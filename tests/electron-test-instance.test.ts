import assert from 'node:assert/strict';
import test from 'node:test';
import {
  acquireElectronInstanceLock,
  configureElectronTestInstance,
  getWslGuestTesseraStateRoot,
  readElectronTestInstanceId,
  resolveElectronServerPort,
  resolveElectronTestInstanceConfig,
  resolveElectronWindowTitle,
} from '@/lib/electron-test-instance';

test('a normal Electron launch keeps the product paths and real instance lock', () => {
  const env: NodeJS.ProcessEnv = {};
  let configuredPath: string | null = null;
  const config = configureElectronTestInstance({
    setPath: (_name, value) => { configuredPath = value; },
  }, env, { platform: 'win32', tmpDir: 'C:\\Temp' });
  let lockCalls = 0;

  assert.equal(config, null);
  assert.equal(configuredPath, null);
  assert.equal(env.TESSERA_DATA_DIR, undefined);
  assert.equal(acquireElectronInstanceLock(() => {
    lockCalls += 1;
    return false;
  }, config), false);
  assert.equal(lockCalls, 1);
  assert.equal(getWslGuestTesseraStateRoot(env), '$HOME/.tessera');
});

test('a test instance derives isolated Windows data and userData roots', () => {
  const env: NodeJS.ProcessEnv = {
    TESSERA_ELECTRON_TEST_INSTANCE: 'test-4',
    TESSERA_ELECTRON_TEST_ROOT: 'C:\\TesseraParallel',
  };
  let configuredPath: string | null = null;
  const config = configureElectronTestInstance({
    setPath: (name, value) => {
      assert.equal(name, 'userData');
      configuredPath = value;
    },
  }, env, { platform: 'win32' });
  let lockCalls = 0;

  assert.deepEqual(config, {
    instanceId: 'test-4',
    rootDir: 'C:\\TesseraParallel\\test-4',
    dataDir: 'C:\\TesseraParallel\\test-4\\data',
    userDataDir: 'C:\\TesseraParallel\\test-4\\user-data',
  });
  assert.equal(configuredPath, config?.userDataDir);
  assert.equal(env.TESSERA_DATA_DIR, config?.dataDir);
  assert.equal(acquireElectronInstanceLock(() => {
    lockCalls += 1;
    return false;
  }, config), true);
  assert.equal(lockCalls, 0);
  assert.equal(
    getWslGuestTesseraStateRoot(env),
    '$HOME/.tessera/test-instances/test-4',
  );
});

test('the Windows default test root is stable under LOCALAPPDATA', () => {
  const config = resolveElectronTestInstanceConfig({
    env: {
      TESSERA_ELECTRON_TEST_INSTANCE: 'debug',
      LOCALAPPDATA: 'D:\\Local',
    },
    platform: 'win32',
  });

  assert.equal(config?.rootDir, 'D:\\Local\\TesseraTestInstances\\debug');
});

test('unsafe test instance ids fail closed instead of falling back to shared state', () => {
  for (const instanceId of ['../escape', 'contains space', 'semi;colon', '']) {
    if (!instanceId) {
      assert.equal(readElectronTestInstanceId({ TESSERA_ELECTRON_TEST_INSTANCE: instanceId }), null);
      continue;
    }
    assert.throws(
      () => readElectronTestInstanceId({ TESSERA_ELECTRON_TEST_INSTANCE: instanceId }),
      /TESSERA_ELECTRON_TEST_INSTANCE must match/,
    );
  }
});

test('normal Electron keeps the fixed port even if a test port leaks into its environment', () => {
  assert.equal(resolveElectronServerPort(32123, null, {
    TESSERA_ELECTRON_TEST_SERVER_PORT: '32124',
  }), 32123);
});

test('an isolated Electron test instance requires and uses its dedicated server port', () => {
  const testInstance = resolveElectronTestInstanceConfig({
    env: {
      TESSERA_ELECTRON_TEST_INSTANCE: 'parallel-1',
      TESSERA_ELECTRON_TEST_ROOT: 'C:\\TesseraParallel',
    },
    platform: 'win32',
  });

  assert.equal(resolveElectronServerPort(32123, testInstance, {
    TESSERA_ELECTRON_TEST_SERVER_PORT: '32124',
  }), 32124);
  assert.throws(
    () => resolveElectronServerPort(32123, testInstance, {}),
    /TESSERA_ELECTRON_TEST_SERVER_PORT must be an integer between 1024 and 65535/,
  );
  assert.throws(
    () => resolveElectronServerPort(32123, testInstance, {
      TESSERA_ELECTRON_TEST_SERVER_PORT: 'not-a-port',
    }),
    /TESSERA_ELECTRON_TEST_SERVER_PORT must be an integer between 1024 and 65535/,
  );
});

test('test windows expose their instance id while normal window titles stay unchanged', () => {
  assert.equal(resolveElectronWindowTitle('Tessera', null), 'Tessera');

  const testInstance = resolveElectronTestInstanceConfig({
    env: {
      TESSERA_ELECTRON_TEST_INSTANCE: 'codex-0812-title-2',
      TESSERA_ELECTRON_TEST_ROOT: 'C:\\TesseraParallel',
    },
    platform: 'win32',
  });

  assert.equal(
    resolveElectronWindowTitle('Tessera', testInstance),
    'Tessera [TEST · codex-0812-title-2]',
  );
  assert.equal(
    resolveElectronWindowTitle('Tessera Board', testInstance),
    'Tessera Board [TEST · codex-0812-title-2]',
  );
});
