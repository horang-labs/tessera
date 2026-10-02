import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fixture } from './automation-fixture';
import { autorunInput } from './fixtures/autorun-contracts';

test('current authenticated HTTP rejects Autorun until the real handler is installed', async () => {
  const f = fixture();
  const dir = await fs.mkdtemp(path.resolve('tmp/autorun-auth-'));
  const previous = { data: process.env.TESSERA_DATA_DIR, electron: process.env.TESSERA_ELECTRON_RUNTIME };
  process.env.TESSERA_DATA_DIR = dir;
  process.env.TESSERA_ELECTRON_RUNTIME = '1';
  try {
    const { NextRequest } = await import('next/server');
    const { ensureAppSecret, APP_SECRET_HEADER } = await import('../src/lib/auth/app-secret');
    const { handleAutomationRequest } = await import('../src/app/api/automations/handler');
    const secret = await ensureAppSecret();
    f.service.deps.owner = async () => ({ userId: 'electron-local-user', agentEnvironment: 'wsl' });
    const request = new NextRequest('http://localhost:3100/api/automations', { method: 'POST',
      headers: { host: 'localhost:3100', origin: 'http://localhost:3100', 'content-type': 'application/json',
        'idempotency-key': 'autorun-contract-characterization', [APP_SECRET_HEADER]: secret },
      body: JSON.stringify(autorunInput()) });
    const result = await handleAutomationRequest(request, { action: 'create' }, f.service);
    assert.equal(result.status, 400);
    assert.equal((await result.json()).error.code, 'INVALID_AUTOMATION');
    assert.deepEqual(f.service.list('electron-local-user', {}).items, []);
  } finally {
    if (previous.data === undefined) delete process.env.TESSERA_DATA_DIR; else process.env.TESSERA_DATA_DIR = previous.data;
    if (previous.electron === undefined) delete process.env.TESSERA_ELECTRON_RUNTIME; else process.env.TESSERA_ELECTRON_RUNTIME = previous.electron;
    f.close(); await fs.rm(dir, { recursive: true });
  }
});
