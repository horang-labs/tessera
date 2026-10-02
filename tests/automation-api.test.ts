import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fixture, input } from './automation-fixture';

test('HTTP enforces real auth/origin and strict owner-only mutation bodies', async () => {
  const f = fixture();
  await fs.mkdir('tmp', { recursive: true });
  const dir = await fs.mkdtemp(path.resolve('tmp/automation-auth-'));
  const previous = { data: process.env.TESSERA_DATA_DIR, electron: process.env.TESSERA_ELECTRON_RUNTIME };
  process.env.TESSERA_DATA_DIR = dir; process.env.TESSERA_ELECTRON_RUNTIME = '1';
  try {
    const { NextRequest } = await import('next/server');
    const { ensureAppSecret, APP_SECRET_HEADER } = await import('../src/lib/auth/app-secret');
    const { handleAutomationRequest } = await import('../src/app/api/automations/handler');
    const secret = await ensureAppSecret();
    const req = (body?: unknown, authenticated = true, origin = 'http://localhost:3100') => new NextRequest('http://localhost:3100/api/automations', {
      method: 'POST', headers: { host: 'localhost:3100', origin, 'content-type': 'application/json', 'idempotency-key': 'request', ...(authenticated ? { [APP_SECRET_HEADER]: secret } : {}) }, body: JSON.stringify(body ?? input()),
    });
    f.service.deps.owner = async () => ({ userId: 'electron-local-user', agentEnvironment: 'wsl' });
    assert.equal((await handleAutomationRequest(req(undefined, false), { action: 'create' }, f.service)).status, 401);
    assert.equal((await handleAutomationRequest(req(undefined, true, 'https://foreign.invalid'), { action: 'create' }, f.service)).status, 403);
    const created = await handleAutomationRequest(req(), { action: 'create' }, f.service);
    assert.equal(created.status, 201);
    const saved = (await created.json()).automation;
    assert.equal(saved.ownerUserId, 'electron-local-user');
    assert.equal((await handleAutomationRequest(req({ ...input(), ownerUserId: 'victim' }), { action: 'create' }, f.service)).status, 400);
    f.service.deps.owner = async () => ({ userId: 'other', agentEnvironment: 'wsl' });
    assert.equal((await handleAutomationRequest(req(), { action: 'create' }, f.service)).status, 403);
  } finally {
    if (previous.data === undefined) delete process.env.TESSERA_DATA_DIR; else process.env.TESSERA_DATA_DIR = previous.data;
    if (previous.electron === undefined) delete process.env.TESSERA_ELECTRON_RUNTIME; else process.env.TESSERA_ELECTRON_RUNTIME = previous.electron;
    f.close(); await fs.rm(dir, { recursive: true });
  }
});
