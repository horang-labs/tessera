import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const tempDir = mkdtempSync(path.join(os.tmpdir(), 'tessera-retention-api-'));
const previousDataDir = process.env.TESSERA_DATA_DIR;
const previousElectronRuntime = process.env.TESSERA_ELECTRON_RUNTIME;
const previousPort = process.env.PORT;

process.env.TESSERA_DATA_DIR = tempDir;
process.env.TESSERA_ELECTRON_RUNTIME = '1';
process.env.PORT = '32124';

test.after(async () => {
  if (previousDataDir === undefined) delete process.env.TESSERA_DATA_DIR;
  else process.env.TESSERA_DATA_DIR = previousDataDir;
  if (previousElectronRuntime === undefined) delete process.env.TESSERA_ELECTRON_RUNTIME;
  else process.env.TESSERA_ELECTRON_RUNTIME = previousElectronRuntime;
  if (previousPort === undefined) delete process.env.PORT;
  else process.env.PORT = previousPort;
  await rm(tempDir, { recursive: true, force: true });
});

test('retention settings require confirmation before save and stay committed if cleanup fails', async () => {
  const { NextRequest } = await import('next/server');
  const { PUT } = await import('../src/app/api/settings/route');
  const { ensureAppSecret, APP_SECRET_HEADER } = await import('../src/lib/auth/app-secret');
  const { getElectronAuthUserId } = await import('../src/lib/electron-user');
  const { SettingsManager } = await import('../src/lib/settings/manager');
  const { normalizeUserSettings } = await import('../src/lib/settings/provider-defaults');
  const userId = await getElectronAuthUserId();
  const secret = await ensureAppSecret();
  const headers = {
    [APP_SECRET_HEADER]: secret,
    'content-type': 'application/json',
    host: 'localhost:32124',
    origin: 'http://localhost:32124',
  };

  await SettingsManager.save(userId, normalizeUserSettings({
    autoDeleteArchivedWorktrees: false,
    archivedWorktreeRetentionDays: 30,
  }));

  const unconfirmed = await PUT(new NextRequest('http://localhost:32124/api/settings', {
    method: 'PUT',
    headers,
    body: JSON.stringify({ autoDeleteArchivedWorktrees: true }),
  }));
  assert.equal(unconfirmed.status, 409);
  assert.equal((await unconfirmed.json()).code, 'archived_worktree_retention_confirmation_required');
  assert.equal((await SettingsManager.load(userId)).autoDeleteArchivedWorktrees, false);

  // The isolated test deliberately leaves the archive database uninitialized.
  // Cleanup therefore fails after save, and the API must still report the
  // already-committed settings as successful.
  const confirmed = await PUT(new NextRequest('http://localhost:32124/api/settings', {
    method: 'PUT',
    headers,
    body: JSON.stringify({
      autoDeleteArchivedWorktrees: true,
      confirmArchivedWorktreePrune: true,
    }),
  }));
  assert.equal(confirmed.status, 200);
  assert.equal((await SettingsManager.load(userId)).autoDeleteArchivedWorktrees, true);

  const persisted = JSON.parse(await readFile(
    path.join(tempDir, 'settings', `${userId}.json`),
    'utf8',
  )) as Record<string, unknown>;
  assert.equal('confirmArchivedWorktreePrune' in persisted, false);
});
