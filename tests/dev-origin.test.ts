import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('a development server can allow its own origin without changing another server’s advertised address', async () => {
  const previous = { ...process.env };
  const root = path.join(os.homedir(), 'tmp');
  await mkdir(root, { recursive: true });
  const dataDir = await mkdtemp(path.join(root, 'tessera-dev-origin-'));
  try {
    process.env.TESSERA_DATA_DIR = dataDir;
    process.env.PORT = '3100';
    process.env.NODE_ENV = 'development';
    process.env.TESSERA_DEV_ORIGIN = 'http://172.17.241.221:3100';
    await writeFile(path.join(dataDir, 'remote-access.json'), JSON.stringify({ advertisedAddress: 'http://172.17.241.221:3101' }));
    const { isOriginAllowed } = await import('../src/lib/auth/allowed-origins');
    const request = { purpose: 'ws-upgrade' as const, method: 'GET', origin: 'http://172.17.241.221:3100' };
    assert.equal(await isOriginAllowed(request), true);
    assert.equal(await isOriginAllowed({ ...request, origin: 'http://untrusted.example:3100' }), false);
    process.env.NODE_ENV = 'production';
    assert.equal(await isOriginAllowed(request), false);
    assert.equal(await isOriginAllowed({ ...request, origin: 'http://172.17.241.221:3101' }), true);
    process.env.NODE_ENV = 'development';
    process.env.TESSERA_DEV_ORIGIN = 'not-a-url';
    assert.equal(await isOriginAllowed(request), false);
    assert.equal(await isOriginAllowed({ ...request, origin: 'http://localhost:3100' }), true);
  } finally {
    for (const key of ['TESSERA_DATA_DIR', 'PORT', 'NODE_ENV', 'TESSERA_DEV_ORIGIN']) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    await rm(dataDir, { recursive: true, force: true });
  }
});
