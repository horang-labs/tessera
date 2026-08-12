import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type {
  ProviderSkillOperation,
  ProviderSkillStatus,
} from '@/lib/cli/provider-skill-management';
import type {
  ProviderSkillIntegrationResult,
  ProviderSkillIntegrationStatus,
} from '@/lib/cli/provider-integration';

function integratedStatus(
  status: ProviderSkillStatus,
  policy: Partial<ProviderSkillIntegrationStatus['policy']> = {},
): ProviderSkillIntegrationStatus {
  return {
    ...status,
    policy: {
      onboarding: 'none',
      canInstall: false,
      canUpdate: false,
      canRemove: false,
      ...policy,
    },
  };
}

test('the authenticated GUI route exposes shared provider skill operations', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tessera-provider-skill-route-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  process.env.TESSERA_DATA_DIR = root;
  process.env.TESSERA_ELECTRON_RUNTIME = '1';
  process.env.PORT = '32123';

  const [{ NextRequest }, route, appSecret] = await Promise.all([
    import('next/server'),
    import('@/lib/cli/provider-skill-route'),
    import('@/lib/auth/app-secret'),
  ]);
  const secret = await appSecret.ensureAppSecret();
  const headers = {
    [appSecret.APP_SECRET_HEADER]: secret,
    'content-type': 'application/json',
    host: 'localhost:32123',
    origin: 'http://localhost:32123',
  };
  const calls: Array<{
    userId: string;
    operation: ProviderSkillOperation;
    providerIds?: string[];
    expectedAgentEnvironment?: string;
  }> = [];
  const result: ProviderSkillIntegrationResult = {
    success: true,
    operation: 'status',
    agentEnvironment: 'wsl',
    providers: [
      integratedStatus({
        providerId: 'codex',
        detected: true,
        state: 'absent',
        consent: 'not-granted',
        ownership: 'none',
      }, { onboarding: 'offer', canInstall: true }),
    ],
  };
  const handlers = route.createProviderSkillRoute(async (userId, request) => {
    calls.push({ userId, ...request });
    return { ...result, operation: request.operation };
  });
  const url = 'http://localhost:32123/api/provider-integrations/skills';

  const status = await handlers.GET(new NextRequest(`${url}?provider=codex`, { headers }));
  assert.equal(status.status, 200);
  assert.deepEqual(await status.json(), result);

  for (const operation of ['install', 'update', 'remove'] as const) {
    const response = await handlers.POST(new NextRequest(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        operation,
        providerIds: ['codex'],
        expectedAgentEnvironment: 'wsl',
      }),
    }));
    assert.equal(response.status, 200);
    assert.equal((await response.json()).operation, operation);
  }

  assert.deepEqual(calls.map(({ operation, providerIds }) => ({ operation, providerIds })), [
    { operation: 'status', providerIds: ['codex'] },
    { operation: 'install', providerIds: ['codex'] },
    { operation: 'update', providerIds: ['codex'] },
    { operation: 'remove', providerIds: ['codex'] },
  ]);
  assert.equal(calls.every(({ userId }) => userId.length > 0), true);
  assert.deepEqual(
    calls.slice(1).map(({ expectedAgentEnvironment }) => expectedAgentEnvironment),
    ['wsl', 'wsl', 'wsl'],
  );
});

test('the GUI route preserves independent provider and Agent Environment snapshots', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tessera-provider-skill-env-route-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  process.env.TESSERA_DATA_DIR = root;
  process.env.TESSERA_ELECTRON_RUNTIME = '1';
  process.env.PORT = '32123';

  const [{ NextRequest }, route, appSecret] = await Promise.all([
    import('next/server'),
    import('@/lib/cli/provider-skill-route'),
    import('@/lib/auth/app-secret'),
  ]);
  const secret = await appSecret.ensureAppSecret();
  const headers = {
    [appSecret.APP_SECRET_HEADER]: secret,
    host: 'localhost:32123',
    origin: 'http://localhost:32123',
  };
  const snapshots: ProviderSkillIntegrationResult[] = [
    {
      success: true,
      operation: 'status',
      agentEnvironment: 'native',
      providers: [
        integratedStatus(
          { providerId: 'codex', detected: true, state: 'ready', consent: 'granted', ownership: 'tessera' },
          { canUpdate: true, canRemove: true },
        ),
        integratedStatus({ providerId: 'opencode', detected: true, state: 'conflict', consent: 'not-granted', ownership: 'user' }),
      ],
    },
    {
      success: true,
      operation: 'status',
      agentEnvironment: 'wsl',
      providers: [
        integratedStatus(
          { providerId: 'codex', detected: true, state: 'absent', consent: 'not-granted', ownership: 'none' },
          { onboarding: 'offer', canInstall: true },
        ),
        integratedStatus({ providerId: 'opencode', detected: false, state: 'absent', consent: 'revoked', ownership: 'none' }),
      ],
    },
  ];
  const handlers = route.createProviderSkillRoute(async () => snapshots.shift()!);
  const request = () => new NextRequest(
    'http://localhost:32123/api/provider-integrations/skills?provider=codex&provider=opencode',
    { headers },
  );

  assert.deepEqual(await (await handlers.GET(request())).json(), {
    success: true,
    operation: 'status',
    agentEnvironment: 'native',
    providers: [
      integratedStatus(
        { providerId: 'codex', detected: true, state: 'ready', consent: 'granted', ownership: 'tessera' },
        { canUpdate: true, canRemove: true },
      ),
      integratedStatus({ providerId: 'opencode', detected: true, state: 'conflict', consent: 'not-granted', ownership: 'user' }),
    ],
  });
  assert.deepEqual(await (await handlers.GET(request())).json(), {
    success: true,
    operation: 'status',
    agentEnvironment: 'wsl',
    providers: [
      integratedStatus(
        { providerId: 'codex', detected: true, state: 'absent', consent: 'not-granted', ownership: 'none' },
        { onboarding: 'offer', canInstall: true },
      ),
      integratedStatus({ providerId: 'opencode', detected: false, state: 'absent', consent: 'revoked', ownership: 'none' }),
    ],
  });
});

test('the GUI route rejects unsupported provider selection before policy execution', async () => {
  const [{ NextRequest }, route] = await Promise.all([
    import('next/server'),
    import('@/lib/cli/provider-skill-route'),
  ]);
  let called = false;
  const handlers = route.createProviderSkillRoute(async () => {
    called = true;
    throw new Error('should not run');
  }, async () => 'test-user');
  const response = await handlers.GET(new NextRequest(
    'http://localhost/api/provider-integrations/skills?provider=unknown',
  ));

  assert.equal(response.status, 400);
  assert.equal(called, false);
});

test('the GUI route requires an explicit provider for consent-changing operations', async () => {
  const [{ NextRequest }, route] = await Promise.all([
    import('next/server'),
    import('@/lib/cli/provider-skill-route'),
  ]);
  let called = false;
  const handlers = route.createProviderSkillRoute(async () => {
    called = true;
    throw new Error('should not run');
  }, async () => 'test-user');

  for (const providerIds of [undefined, []]) {
    const response = await handlers.POST(new NextRequest(
      'http://localhost/api/provider-integrations/skills',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          operation: 'install',
          expectedAgentEnvironment: 'native',
          ...(providerIds ? { providerIds } : {}),
        }),
      },
    ));
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /explicitly select/);
  }
  const missingEnvironment = await handlers.POST(new NextRequest(
    'http://localhost/api/provider-integrations/skills',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ operation: 'install', providerIds: ['codex'] }),
    },
  ));
  assert.equal(missingEnvironment.status, 400);
  assert.match((await missingEnvironment.json()).error, /expectedAgentEnvironment/);
  assert.equal(called, false);
});
