import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveDatabaseLocation } from '../src/lib/db/location';

test('production-mode preview retains branch DB only with explicit opt-out', async () => {
  const keys = ['NODE_ENV', 'TESSERA_PRODUCTION_DB', 'TESSERA_CLI', 'ELECTRON_CHILD', 'TESSERA_ELECTRON_SERVER'];
  const previous = { ...process.env };
  const resolve = (branch = 'dev') => resolveDatabaseLocation({
    dbDir: '/diagnostic-test-no-io', detectGitBranch: async () => branch,
  });
  try {
    for (const key of keys) delete process.env[key];
    process.env.NODE_ENV = 'production';
    assert.equal((await resolve()).dbName, 'tessera');
    process.env.TESSERA_PRODUCTION_DB = '0';
    assert.equal((await resolve()).dbName, 'tessera-dev');
    assert.equal((await resolve()).source, 'git-non-main-branch');
    assert.equal((await resolve('main')).dbName, 'tessera');
    for (const key of ['TESSERA_CLI', 'ELECTRON_CHILD', 'TESSERA_ELECTRON_SERVER']) {
      process.env[key] = '1';
      assert.equal((await resolve()).dbName, 'tessera');
      delete process.env[key];
    }
    process.env.TESSERA_PRODUCTION_DB = '1';
    assert.equal((await resolve()).dbName, 'tessera');
  } finally {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
});
