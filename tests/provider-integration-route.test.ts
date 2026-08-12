import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { ProviderIntegrationLaunchDecision } from '@/lib/cli/provider-integration';

test('the authenticated GUI route exposes the shared Codex lifecycle operations', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tessera-provider-route-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  process.env.TESSERA_DATA_DIR = root;
  process.env.TESSERA_ELECTRON_RUNTIME = '1';
  process.env.PORT = '32123';

  const [{ NextRequest }, route, appSecret] = await Promise.all([
    import('next/server'),
    import('@/lib/cli/codex-lifecycle-route'),
    import('@/lib/auth/app-secret'),
  ]);
  const secret = await appSecret.ensureAppSecret();
  const headers = {
    [appSecret.APP_SECRET_HEADER]: secret,
    'content-type': 'application/json',
    host: 'localhost:32123',
    origin: 'http://localhost:32123',
  };
  const calls: Array<{ userId: string; operation: string }> = [];
  const decision: ProviderIntegrationLaunchDecision = {
    providerHome: { owner: 'agent-environment', agentEnvironment: 'native' },
    lifecycle: {
      requirement: 'required',
      state: 'installed',
      consent: 'granted',
      trust: 'trusted',
      installedVersion: '1.2.3',
      currentVersion: '1.2.3',
    },
    skill: {
      requirement: 'optional',
      state: 'unchecked',
      consent: 'unchecked',
      trust: 'unchecked',
    },
    health: { state: 'healthy' },
  };
  const handlers = route.createCodexLifecycleRoute(async (userId, operation) => {
    calls.push({ userId, operation });
    return decision;
  });
  const url = 'http://localhost:32123/api/provider-integrations/codex/lifecycle';

  const status = await handlers.GET(new NextRequest(url, { headers }));
  assert.equal(status.status, 200);
  assert.deepEqual(await status.json(), decision);

  const missingConsent = await handlers.POST(new NextRequest(url, {
    method: 'POST', headers, body: JSON.stringify({ operation: 'install' }),
  }));
  assert.equal(missingConsent.status, 400);

  for (const operation of ['install', 'update', 'remove'] as const) {
    const response = await handlers.POST(new NextRequest(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(operation === 'install'
        ? { operation, consent: 'granted' }
        : { operation }),
    }));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), decision);
  }
  assert.deepEqual(calls.map(({ operation }) => operation), [
    'status', 'install', 'update', 'remove',
  ]);
  assert.equal(calls.every(({ userId }) => userId.length > 0), true);
});
