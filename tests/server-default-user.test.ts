import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('resolves the server default user without request credentials', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'tessera-default-user-'));
  const usersFilePath = path.join(tempDir, 'users.json');
  const originalUsersFilePath = process.env.USERS_FILE_PATH;
  const originalElectronChild = process.env.ELECTRON_CHILD;
  const originalElectronRuntime = process.env.TESSERA_ELECTRON_RUNTIME;
  const originalElectronBypass = process.env.TESSERA_ELECTRON_AUTH_BYPASS;

  try {
    await writeFile(usersFilePath, JSON.stringify({
      users: [{
        id: 'persisted-user',
        username: 'persisted',
        passwordHash: 'unused',
        createdAt: '2026-08-03T00:00:00.000Z',
        lastLoginAt: '2026-08-03T00:00:00.000Z',
      }],
    }));
    process.env.USERS_FILE_PATH = usersFilePath;
    delete process.env.ELECTRON_CHILD;
    delete process.env.TESSERA_ELECTRON_RUNTIME;
    delete process.env.TESSERA_ELECTRON_AUTH_BYPASS;

    const { resolveServerDefaultUserId } = await import('../src/lib/server-default-user');

    assert.equal(await resolveServerDefaultUserId(), 'persisted-user');

    process.env.TESSERA_ELECTRON_AUTH_BYPASS = '1';
    assert.equal(await resolveServerDefaultUserId(), 'persisted-user');

    process.env.TESSERA_ELECTRON_RUNTIME = '1';
    assert.equal(await resolveServerDefaultUserId(), 'electron-local-user');

    delete process.env.TESSERA_ELECTRON_RUNTIME;
    delete process.env.TESSERA_ELECTRON_AUTH_BYPASS;
    process.env.ELECTRON_CHILD = '1';
    assert.equal(await resolveServerDefaultUserId(), 'electron-local-user');
  } finally {
    if (originalUsersFilePath === undefined) delete process.env.USERS_FILE_PATH;
    else process.env.USERS_FILE_PATH = originalUsersFilePath;
    if (originalElectronChild === undefined) delete process.env.ELECTRON_CHILD;
    else process.env.ELECTRON_CHILD = originalElectronChild;
    if (originalElectronRuntime === undefined) delete process.env.TESSERA_ELECTRON_RUNTIME;
    else process.env.TESSERA_ELECTRON_RUNTIME = originalElectronRuntime;
    if (originalElectronBypass === undefined) delete process.env.TESSERA_ELECTRON_AUTH_BYPASS;
    else process.env.TESSERA_ELECTRON_AUTH_BYPASS = originalElectronBypass;
    await rm(tempDir, { recursive: true, force: true });
  }
});
