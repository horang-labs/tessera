import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveControlUserId } from '@/lib/control/user-context';

test('Electron-local Control mutations use the same user identity as HTTP and WebSocket auth', async () => {
  let usersFileReads = 0;
  const userId = await resolveControlUserId({
    isElectronRuntime: () => true,
    getElectronAuthUserId: async () => 'electron-local-user',
    readFirstUserId: async () => {
      usersFileReads += 1;
      return 'stale-file-user';
    },
  });

  assert.equal(userId, 'electron-local-user');
  assert.equal(usersFileReads, 0);
});

test('authenticated web Control mutations retain the configured first user identity', async () => {
  let electronUserReads = 0;
  const userId = await resolveControlUserId({
    isElectronRuntime: () => false,
    getElectronAuthUserId: async () => {
      electronUserReads += 1;
      return 'electron-local-user';
    },
    readFirstUserId: async () => 'web-user',
  });

  assert.equal(userId, 'web-user');
  assert.equal(electronUserReads, 0);
});
