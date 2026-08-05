import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';
import { pairApprovedDevice } from './helpers/approved-device';

let tempDir: string;
const previousDataDir = process.env.TESSERA_DATA_DIR;
const previousElectronRuntime = process.env.TESSERA_ELECTRON_RUNTIME;
const previousAuthKeysDir = process.env.AUTH_KEYS_DIR;
const previousUsersFilePath = process.env.USERS_FILE_PATH;
const previousPort = process.env.PORT;
let appSecretModule: typeof import('../src/lib/auth/app-secret');

before(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), 'tessera-request-gate-'));
  process.env.TESSERA_DATA_DIR = tempDir;
  process.env.TESSERA_ELECTRON_RUNTIME = '1';
  process.env.AUTH_KEYS_DIR = path.join(tempDir, 'auth');
  process.env.USERS_FILE_PATH = path.join(tempDir, 'users.json');
  process.env.PORT = '32123';
  await writeFile(process.env.USERS_FILE_PATH, JSON.stringify({
    users: [
      {
        id: 'other-user',
        username: 'other',
        passwordHash: 'unused',
        createdAt: '2026-08-03T00:00:00.000Z',
        lastLoginAt: '2026-08-03T00:00:00.000Z',
      },
      {
        id: 'persisted-user',
        username: 'persisted',
        passwordHash: 'unused',
        createdAt: '2026-08-03T00:00:00.000Z',
        lastLoginAt: '2026-08-03T00:00:00.000Z',
      },
    ],
  }));
  appSecretModule = await import('../src/lib/auth/app-secret');
});

after(async () => {
  if (previousDataDir === undefined) delete process.env.TESSERA_DATA_DIR;
  else process.env.TESSERA_DATA_DIR = previousDataDir;
  if (previousElectronRuntime === undefined) delete process.env.TESSERA_ELECTRON_RUNTIME;
  else process.env.TESSERA_ELECTRON_RUNTIME = previousElectronRuntime;
  if (previousAuthKeysDir === undefined) delete process.env.AUTH_KEYS_DIR;
  else process.env.AUTH_KEYS_DIR = previousAuthKeysDir;
  if (previousUsersFilePath === undefined) delete process.env.USERS_FILE_PATH;
  else process.env.USERS_FILE_PATH = previousUsersFilePath;
  if (previousPort === undefined) delete process.env.PORT;
  else process.env.PORT = previousPort;
  await rm(tempDir, { recursive: true, force: true });
});

function requestInput({
  headers = {},
  cookies = {},
  purpose = 'http',
  rawUrl = '/api/projects',
  host = 'localhost:32123',
  method = 'GET',
  origin = 'http://localhost:32123',
}: {
  headers?: Record<string, string>;
  cookies?: Record<string, string>;
  purpose?: 'http' | 'ws-upgrade';
  rawUrl?: string;
  host?: string;
  method?: string;
  origin?: string;
} = {}) {
  return {
    purpose,
    method,
    rawUrl,
    host,
    origin,
    cookies,
    headers,
  };
}

test('stores and reads the normalized advertised address through the settings API', async () => {
  const { NextRequest } = await import('next/server');
  const { GET, PUT } = await import('../src/app/api/settings/route');
  const { MACHINE_SETTINGS_PATH } = await import('../src/lib/settings/machine-settings');
  const secret = await appSecretModule.ensureAppSecret();
  const headers = {
    [appSecretModule.APP_SECRET_HEADER]: secret,
    'content-type': 'application/json',
    host: 'localhost:32123',
    origin: 'http://localhost:32123',
  };

  const updateResponse = await PUT(new NextRequest('http://localhost:32123/api/settings', {
    method: 'PUT',
    headers,
    body: JSON.stringify({
      machineSettings: {
        advertisedAddress: 'https://example.ts.net:443/a/path?ignored=yes',
      },
    }),
  }));
  assert.equal(updateResponse.status, 200);
  assert.deepEqual((await updateResponse.json()).machineSettings, {
    advertisedAddress: 'https://example.ts.net',
  });

  const readResponse = await GET(new NextRequest('http://localhost:32123/api/settings', {
    headers,
  }));
  assert.equal(readResponse.status, 200);
  assert.deepEqual((await readResponse.json()).machineSettings, {
    advertisedAddress: 'https://example.ts.net',
  });
  assert.equal(MACHINE_SETTINGS_PATH, path.join(tempDir, 'remote-access.json'));
  assert.equal((await stat(MACHINE_SETTINGS_PATH)).mode & 0o777, 0o600);
});

test('rejects an invalid advertised address without replacing the stored value', async () => {
  const { NextRequest } = await import('next/server');
  const { PUT } = await import('../src/app/api/settings/route');
  const { loadMachineSettings } = await import('../src/lib/settings/machine-settings');
  const secret = await appSecretModule.ensureAppSecret();
  const response = await PUT(new NextRequest('http://localhost:32123/api/settings', {
    method: 'PUT',
    headers: {
      [appSecretModule.APP_SECRET_HEADER]: secret,
      'content-type': 'application/json',
      host: 'localhost:32123',
      origin: 'http://localhost:32123',
    },
    body: JSON.stringify({
      machineSettings: { advertisedAddress: 'ftp://example.ts.net' },
    }),
  }));

  assert.equal(response.status, 400);
  assert.deepEqual(await loadMachineSettings(), {
    advertisedAddress: 'https://example.ts.net',
  });
});

test('ignores remote-access settings from a device while saving its other settings', async () => {
  const { NextRequest } = await import('next/server');
  const { PUT } = await import('../src/app/api/settings/route');
  const {
    clearDeviceRegistry,
  } = await import('../src/lib/auth/device-registry');
  const { loadMachineSettings, saveMachineSettings } = await import(
    '../src/lib/settings/machine-settings'
  );
  await clearDeviceRegistry();
  await saveMachineSettings({ advertisedAddress: 'https://local-only.example' });
  const { device } = await pairApprovedDevice('Remote phone');
  process.env.TESSERA_ELECTRON_AUTH_BYPASS = '1';
  let response: Response;
  try {
    response = await PUT(new NextRequest('http://localhost:32123/api/settings', {
      method: 'PUT',
      headers: {
        cookie: `device=${device.token}`,
        'content-type': 'application/json',
        host: 'localhost:32123',
        origin: 'http://localhost:32123',
      },
      body: JSON.stringify({
        fontSize: 1.1875,
        machineSettings: { advertisedAddress: 'ftp://would-fail-for-the-app.example' },
      }),
    }));
  } finally {
    delete process.env.TESSERA_ELECTRON_AUTH_BYPASS;
  }

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.settings.fontSize, 1.1875);
  assert.deepEqual(body.machineSettings, {
    advertisedAddress: 'https://local-only.example',
  });
  assert.deepEqual(await loadMachineSettings(), {
    advertisedAddress: 'https://local-only.example',
  });
});

test('rejects an unauthenticated HTTP route even when the legacy Electron bypass flag is set', async () => {
  const { NextRequest } = await import('next/server');
  const { GET } = await import('../src/app/api/settings/route');
  process.env.TESSERA_ELECTRON_AUTH_BYPASS = '1';

  try {
    const response = await GET(new NextRequest('http://localhost:32123/api/settings', {
      headers: { host: 'localhost:32123' },
    }));

    assert.equal(response.status, 401);
  } finally {
    delete process.env.TESSERA_ELECTRON_AUTH_BYPASS;
  }
});

test('rejects an unauthenticated API request at the proxy when the legacy Electron bypass flag is set', async () => {
  const { NextRequest } = await import('next/server');
  const { proxy } = await import('../src/proxy');
  process.env.TESSERA_ELECTRON_AUTH_BYPASS = '1';

  try {
    const response = await proxy(new NextRequest('http://localhost:32123/api/settings', {
      headers: { host: 'localhost:32123' },
    }));

    assert.equal(response.status, 401);
  } finally {
    delete process.env.TESSERA_ELECTRON_AUTH_BYPASS;
  }
});

test('rejects an unauthenticated auth check when the legacy Electron bypass flag is set', async () => {
  const { NextRequest } = await import('next/server');
  const { GET } = await import('../src/app/api/auth/me/route');
  process.env.TESSERA_ELECTRON_AUTH_BYPASS = '1';

  try {
    const response = await GET(new NextRequest('http://localhost:32123/api/auth/me', {
      headers: { host: 'localhost:32123' },
    }));

    assert.equal(response.status, 401);
  } finally {
    delete process.env.TESSERA_ELECTRON_AUTH_BYPASS;
  }
});

test('rejects a state-changing settings request from a disallowed Origin during auth bypass', async () => {
  const { NextRequest } = await import('next/server');
  const { PUT } = await import('../src/app/api/settings/route');
  process.env.TESSERA_ELECTRON_AUTH_BYPASS = '1';

  try {
    const response = await PUT(new NextRequest('http://localhost:32123/api/settings', {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        host: 'localhost:32123',
        origin: 'http://localhost:45678',
      },
      body: JSON.stringify({
        machineSettings: { advertisedAddress: 'https://rejected.example.com' },
      }),
    }));

    assert.equal(response.status, 403);
  } finally {
    delete process.env.TESSERA_ELECTRON_AUTH_BYPASS;
  }
});

test('rejects a state-changing auth API request from a disallowed Origin at the proxy', async () => {
  const { NextRequest } = await import('next/server');
  const { proxy } = await import('../src/proxy');
  process.env.TESSERA_ELECTRON_AUTH_BYPASS = '1';

  try {
    const response = await proxy(new NextRequest('http://localhost:32123/api/auth/logout', {
      method: 'POST',
      headers: {
        host: 'localhost:32123',
        origin: 'http://localhost:45678',
      },
    }));
    assert.equal(response.status, 403);
  } finally {
    delete process.env.TESSERA_ELECTRON_AUTH_BYPASS;
  }
});

test('creates the app secret as a private 32-byte base64url file', async () => {
  const generated = await appSecretModule.ensureAppSecret();
  const stored = (await readFile(appSecretModule.APP_SECRET_PATH, 'utf8')).trim();
  const fileStat = await stat(appSecretModule.APP_SECRET_PATH);

  assert.match(generated, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(stored, generated);
  assert.equal(fileStat.mode & 0o777, 0o600);
});

test('uses the secret file as truth when a module cache is stale', async () => {
  await appSecretModule.ensureAppSecret();
  const replacement = 'z'.repeat(43);
  await writeFile(appSecretModule.APP_SECRET_PATH, `${replacement}\n`, { mode: 0o600 });
  const future = new Date(Date.now() + 2_000);
  await utimes(appSecretModule.APP_SECRET_PATH, future, future);

  assert.equal(await appSecretModule.matchesAppSecret(replacement), true);
});

test('allows the exact app secret before considering other credentials', async () => {
  const secret = await appSecretModule.ensureAppSecret();
  const { evaluateRequest } = await import('../src/lib/auth/request-gate');

  assert.deepEqual(
    await evaluateRequest(requestInput({
      headers: { [appSecretModule.APP_SECRET_HEADER]: secret },
    })),
    { allow: true, userId: 'electron-local-user', kind: 'app' },
  );
});

test('preserves the JWT subject in web mode after cheaper credentials miss', async () => {
  const { ensureRSAKeys } = await import('../src/lib/auth/keys');
  const { generateToken } = await import('../src/lib/auth/jwt');
  const { evaluateRequest } = await import('../src/lib/auth/request-gate');
  await ensureRSAKeys();
  const jwt = await generateToken('persisted-user', 'persisted');
  delete process.env.TESSERA_ELECTRON_RUNTIME;

  try {
    assert.deepEqual(
      await evaluateRequest(requestInput({
        headers: { [appSecretModule.APP_SECRET_HEADER]: 'x'.repeat(43) },
        cookies: { device: 'not-implemented-yet', jwt },
      })),
      { allow: true, userId: 'persisted-user', kind: 'jwt' },
    );
  } finally {
    process.env.TESSERA_ELECTRON_RUNTIME = '1';
  }
});

test('maps a valid JWT to the Electron server user in Electron mode', async () => {
  const { ensureRSAKeys } = await import('../src/lib/auth/keys');
  const { generateToken } = await import('../src/lib/auth/jwt');
  const { evaluateRequest } = await import('../src/lib/auth/request-gate');
  await ensureRSAKeys();
  const jwt = await generateToken('persisted-user', 'persisted');

  assert.deepEqual(
    await evaluateRequest(requestInput({ cookies: { jwt } })),
    { allow: true, userId: 'electron-local-user', kind: 'jwt' },
  );
});

test('prefers the app secret when app and JWT credentials are both valid', async () => {
  const { ensureRSAKeys } = await import('../src/lib/auth/keys');
  const { generateToken } = await import('../src/lib/auth/jwt');
  const { evaluateRequest } = await import('../src/lib/auth/request-gate');
  const secret = await appSecretModule.ensureAppSecret();
  await ensureRSAKeys();
  const jwt = await generateToken('persisted-user', 'persisted');

  assert.deepEqual(
    await evaluateRequest(requestInput({
      headers: { [appSecretModule.APP_SECRET_HEADER]: secret },
      cookies: { jwt },
    })),
    { allow: true, userId: 'electron-local-user', kind: 'app' },
  );
});

test('accepts a redeemed device token and rejects it immediately after revocation', async () => {
  const {
    DeviceRegistryError,
    PAIRING_TOKEN_TTL_MS,
    claimPairingToken,
    revokeDevice,
  } = await import('../src/lib/auth/device-registry');
  const { evaluateRequest } = await import('../src/lib/auth/request-gate');
  const issuedAt = new Date('2026-08-03T00:00:00.000Z');
  const { pairing, device } = await pairApprovedDevice('Test phone', issuedAt);
  await assert.rejects(
    () => claimPairingToken({
      token: pairing.token,
      name: 'Second phone',
      browser: 'Test browser',
      platform: 'Test platform',
      remoteAddress: '127.0.0.1',
    }, undefined, new Date(issuedAt.getTime() + PAIRING_TOKEN_TTL_MS + 1)),
    (error: unknown) => error instanceof DeviceRegistryError
      && error.code === 'pairing-used',
  );

  assert.deepEqual(
    await evaluateRequest(requestInput({ cookies: { device: device.token } })),
    {
      allow: true,
      userId: 'electron-local-user',
      kind: 'device',
      deviceId: device.id,
    },
  );

  assert.equal(await revokeDevice(device.id), true);
  assert.deepEqual(
    await evaluateRequest(requestInput({ cookies: { device: device.token } })),
    { allow: false, reason: 'unauthorized', status: 401 },
  );
});

test('rejects an expired pairing token and invalidates it on the first failed claim', async () => {
  const {
    DeviceRegistryError,
    PAIRING_TOKEN_TTL_MS,
    issuePairingToken,
    claimPairingToken,
  } = await import('../src/lib/auth/device-registry');
  const issuedAt = new Date('2026-08-03T00:00:00.000Z');
  const pairing = await issuePairingToken(issuedAt);

  await assert.rejects(
    () => claimPairingToken({
      token: pairing.token,
      name: 'Expired phone',
      browser: 'Test browser',
      platform: 'Test platform',
      remoteAddress: '127.0.0.1',
    }, undefined, new Date(issuedAt.getTime() + PAIRING_TOKEN_TTL_MS)),
    (error: unknown) => error instanceof DeviceRegistryError
      && error.code === 'pairing-expired',
  );
  await assert.rejects(
    () => claimPairingToken({
      token: pairing.token,
      name: 'Expired phone',
      browser: 'Test browser',
      platform: 'Test platform',
      remoteAddress: '127.0.0.1',
    }, undefined, new Date(issuedAt.getTime() + PAIRING_TOKEN_TTL_MS + 1)),
    (error: unknown) => error instanceof DeviceRegistryError
      && error.code === 'pairing-invalid',
  );
});

test('pairing APIs require local approval before issuing one device cookie', async () => {
  const { NextRequest } = await import('next/server');
  const pairingRoute = await import('../src/app/api/pairing/route');
  const pairingRequestsRoute = await import('../src/app/api/pairing/requests/route');
  const pairingRequestRoute = await import('../src/app/api/pairing/requests/[id]/route');
  const devicesRoute = await import('../src/app/api/devices/route');
  const deviceRoute = await import('../src/app/api/devices/[id]/route');
  const {
    clearDeviceRegistry,
    listDevices,
    PAIRING_REQUEST_COOKIE,
  } = await import('../src/lib/auth/device-registry');
  const { evaluateRequest } = await import('../src/lib/auth/request-gate');
  const secret = await appSecretModule.ensureAppSecret();
  await clearDeviceRegistry();
  const appHeaders = {
    [appSecretModule.APP_SECRET_HEADER]: secret,
    'content-type': 'application/json',
    host: 'localhost:32123',
    origin: 'http://localhost:32123',
  };

  const issueResponse = await pairingRoute.POST(new NextRequest(
    'http://localhost:32123/api/pairing',
    { method: 'POST', headers: appHeaders },
  ));
  assert.equal(issueResponse.status, 201);
  const issued = await issueResponse.json() as { pairingLink: string; pairingToken?: string };
  assert.equal(issued.pairingToken, undefined);
  const issuedToken = new URLSearchParams(new URL(issued.pairingLink).hash.slice(1)).get('t');
  assert.ok(issuedToken);

  const claimResponse = await pairingRequestsRoute.POST(new NextRequest(
    'http://localhost:32123/api/pairing/requests',
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        host: 'localhost:32123',
        origin: 'http://localhost:32123',
        'user-agent': 'Mobile Safari on iOS',
        'sec-ch-ua-platform': 'iOS',
        'x-tessera-remote-address': '100.64.0.8',
      },
      body: JSON.stringify({ token: issuedToken, name: 'Test phone' }),
    },
  ));
  assert.equal(claimResponse.status, 201);
  const claim = await claimResponse.json() as {
    request: { id: string; comparisonCode: string; expiresAt: string };
  };
  assert.match(claim.request.comparisonCode, /^\d{6}$/);
  const pendingSetCookie = claimResponse.headers.get('set-cookie') ?? '';
  assert.match(pendingSetCookie, new RegExp(`^${PAIRING_REQUEST_COOKIE}=[A-Za-z0-9_-]{43};`));
  assert.match(pendingSetCookie, /HttpOnly/i);
  assert.match(pendingSetCookie, /SameSite=strict/i);
  assert.match(pendingSetCookie, /Path=\/api\/pairing\/requests/i);
  assert.doesNotMatch(pendingSetCookie, /(?:^|;\s*)device=/);
  const pollingCredential = new RegExp(
    `(?:^|;\\s*)${PAIRING_REQUEST_COOKIE}=([^;]+)`,
  ).exec(pendingSetCookie)?.[1];
  assert.ok(pollingCredential);
  assert.deepEqual(await listDevices(), []);

  const unauthenticatedMe = await evaluateRequest(requestInput({
    cookies: { [PAIRING_REQUEST_COOKIE]: pollingCredential },
  }));
  assert.deepEqual(unauthenticatedMe, { allow: false, reason: 'unauthorized', status: 401 });
  assert.deepEqual(
    await evaluateRequest(requestInput({
      purpose: 'ws-upgrade',
      cookies: { [PAIRING_REQUEST_COOKIE]: pollingCredential },
    })),
    { allow: false, reason: 'unauthorized', wsCloseCode: 1008 },
  );

  const localListResponse = await pairingRequestsRoute.GET(new NextRequest(
    'http://localhost:32123/api/pairing/requests',
    { headers: appHeaders },
  ));
  assert.equal(localListResponse.status, 200);
  const pendingRequests = (await localListResponse.json()).requests as Array<{
    id: string;
    name: string;
    browser: string;
    platform: string;
    remoteAddress: string;
    comparisonCode: string;
    status: string;
  }>;
  assert.deepEqual(pendingRequests.map((request) => ({
    id: request.id,
    name: request.name,
    remoteAddress: request.remoteAddress,
    comparisonCode: request.comparisonCode,
    status: request.status,
  })), [{
    id: claim.request.id,
    name: 'Test phone',
    remoteAddress: '100.64.0.8',
    comparisonCode: claim.request.comparisonCode,
    status: 'pending',
  }]);
  assert.match(pendingRequests[0].browser, /Safari/i);
  assert.match(pendingRequests[0].platform, /iOS/i);

  const pendingPoll = await pairingRequestRoute.POST(new NextRequest(
    `http://localhost:32123/api/pairing/requests/${claim.request.id}`,
    {
      method: 'POST',
      headers: {
        cookie: `${PAIRING_REQUEST_COOKIE}=${pollingCredential}`,
        host: 'localhost:32123',
        origin: 'http://localhost:32123',
      },
    },
  ), { params: Promise.resolve({ id: claim.request.id }) });
  assert.equal(pendingPoll.status, 200);
  assert.deepEqual(await pendingPoll.json(), {
    status: 'pending',
    expiresAt: claim.request.expiresAt,
  });

  const unauthenticatedApproval = await pairingRequestRoute.PATCH(new NextRequest(
    `http://localhost:32123/api/pairing/requests/${claim.request.id}`,
    {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
        host: 'localhost:32123',
        origin: 'http://localhost:32123',
      },
      body: JSON.stringify({ decision: 'approve' }),
    },
  ), { params: Promise.resolve({ id: claim.request.id }) });
  assert.equal(unauthenticatedApproval.status, 401);

  const approveResponse = await pairingRequestRoute.PATCH(new NextRequest(
    `http://localhost:32123/api/pairing/requests/${claim.request.id}`,
    {
      method: 'PATCH',
      headers: appHeaders,
      body: JSON.stringify({ decision: 'approve' }),
    },
  ), { params: Promise.resolve({ id: claim.request.id }) });
  assert.equal(approveResponse.status, 200);
  assert.equal((await approveResponse.json()).request.status, 'approved');
  assert.deepEqual(await listDevices(), [], 'approval alone must not create a ghost device');

  const redeemResponse = await pairingRequestRoute.POST(new NextRequest(
    `http://localhost:32123/api/pairing/requests/${claim.request.id}`,
    {
      method: 'POST',
      headers: {
        cookie: `${PAIRING_REQUEST_COOKIE}=${pollingCredential}`,
        host: 'localhost:32123',
        origin: 'http://localhost:32123',
      },
    },
  ), { params: Promise.resolve({ id: claim.request.id }) });
  assert.equal(redeemResponse.status, 200);
  const redeemed = await redeemResponse.json() as {
    status: string;
    device: { id: string; name: string };
  };
  assert.equal(redeemed.status, 'approved');
  assert.equal(redeemed.device.name, 'Test phone');
  const setCookie = redeemResponse.headers.get('set-cookie') ?? '';
  assert.match(setCookie, /(?:^|,\s*)device=[A-Za-z0-9_-]{43};/);
  assert.match(setCookie, /HttpOnly/i);
  const deviceToken = /(?:^|,\s*)device=([^;]+)/.exec(setCookie)?.[1];
  assert.ok(deviceToken);

  const duplicatePoll = await pairingRequestRoute.POST(new NextRequest(
    `http://localhost:32123/api/pairing/requests/${claim.request.id}`,
    {
      method: 'POST',
      headers: {
        cookie: `${PAIRING_REQUEST_COOKIE}=${pollingCredential}`,
        host: 'localhost:32123',
        origin: 'http://localhost:32123',
      },
    },
  ), { params: Promise.resolve({ id: claim.request.id }) });
  assert.equal(duplicatePoll.status, 409);
  assert.equal((await duplicatePoll.json()).status, 'used');

  const deviceHeaders = {
    cookie: `device=${deviceToken}`,
    host: 'localhost:32123',
    origin: 'http://localhost:32123',
  };
  const listResponse = await devicesRoute.GET(new NextRequest(
    'http://localhost:32123/api/devices',
    { headers: deviceHeaders },
  ));
  assert.equal(listResponse.status, 200);
  const listed = (await listResponse.json()).devices as Array<{
    id: string;
    name: string;
    registeredAt: string;
    lastSeenAt: string | null;
    connected: boolean;
  }>;
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, redeemed.device.id);
  assert.equal(listed[0].name, 'Test phone');
  assert.equal(listed[0].connected, false);
  assert.match(listed[0].registeredAt, /^2026-/);
  assert.match(listed[0].lastSeenAt ?? '', /^2026-/);

  const remoteIssueResponse = await pairingRoute.POST(new NextRequest(
    'http://localhost:32123/api/pairing',
    { method: 'POST', headers: deviceHeaders },
  ));
  assert.equal(remoteIssueResponse.status, 403);

  const nextIssueResponse = await pairingRoute.POST(new NextRequest(
    'http://localhost:32123/api/pairing',
    { method: 'POST', headers: appHeaders },
  ));
  const nextIssue = await nextIssueResponse.json() as { pairingLink: string };
  const nextToken = new URLSearchParams(new URL(nextIssue.pairingLink).hash.slice(1)).get('t');
  assert.ok(nextToken);
  const nextClaimResponse = await pairingRequestsRoute.POST(new NextRequest(
    'http://localhost:32123/api/pairing/requests',
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        host: 'localhost:32123',
        origin: 'http://localhost:32123',
        'x-tessera-remote-address': '100.64.0.9',
      },
      body: JSON.stringify({ token: nextToken, name: 'Second phone' }),
    },
  ));
  const nextClaim = await nextClaimResponse.json() as { request: { id: string } };
  const deviceApproval = await pairingRequestRoute.PATCH(new NextRequest(
    `http://localhost:32123/api/pairing/requests/${nextClaim.request.id}`,
    {
      method: 'PATCH',
      headers: {
        cookie: `device=${deviceToken}`,
        'content-type': 'application/json',
        host: 'localhost:32123',
        origin: 'http://localhost:32123',
      },
      body: JSON.stringify({ decision: 'approve' }),
    },
  ), { params: Promise.resolve({ id: nextClaim.request.id }) });
  assert.equal(deviceApproval.status, 403);

  const { ensureRSAKeys } = await import('../src/lib/auth/keys');
  const { generateToken } = await import('../src/lib/auth/jwt');
  await ensureRSAKeys();
  const jwt = await generateToken('persisted-user', 'persisted');
  const jwtApproval = await pairingRequestRoute.PATCH(new NextRequest(
    `http://localhost:32123/api/pairing/requests/${nextClaim.request.id}`,
    {
      method: 'PATCH',
      headers: {
        cookie: `jwt=${jwt}`,
        'content-type': 'application/json',
        host: 'localhost:32123',
        origin: 'http://localhost:32123',
      },
      body: JSON.stringify({ decision: 'approve' }),
    },
  ), { params: Promise.resolve({ id: nextClaim.request.id }) });
  assert.equal(jwtApproval.status, 403);

  const denyResponse = await pairingRequestRoute.PATCH(new NextRequest(
    `http://localhost:32123/api/pairing/requests/${nextClaim.request.id}`,
    {
      method: 'PATCH',
      headers: appHeaders,
      body: JSON.stringify({ decision: 'deny' }),
    },
  ), { params: Promise.resolve({ id: nextClaim.request.id }) });
  assert.equal(denyResponse.status, 200);

  const revokeResponse = await deviceRoute.DELETE(new NextRequest(
    `http://localhost:32123/api/devices/${redeemed.device.id}`,
    { method: 'DELETE', headers: deviceHeaders },
  ), { params: Promise.resolve({ id: redeemed.device.id }) });
  assert.equal(revokeResponse.status, 200);
  assert.deepEqual(
    await evaluateRequest(requestInput({ cookies: { device: deviceToken } })),
    { allow: false, reason: 'unauthorized', status: 401 },
  );
});

test('does not treat the Electron auth bypass as an app credential for pairing issuance', async () => {
  const { NextRequest } = await import('next/server');
  const pairingRoute = await import('../src/app/api/pairing/route');
  const { clearDeviceRegistry } = await import('../src/lib/auth/device-registry');
  await clearDeviceRegistry();
  process.env.TESSERA_ELECTRON_AUTH_BYPASS = '1';

  try {
    const response = await pairingRoute.POST(new NextRequest(
      'http://localhost:32123/api/pairing',
      {
        method: 'POST',
        headers: {
          host: 'localhost:32123',
          origin: 'http://localhost:32123',
        },
      },
    ));
    assert.equal(response.status, 401);
  } finally {
    delete process.env.TESSERA_ELECTRON_AUTH_BYPASS;
  }
});

test('shows a link-only pairing response to an authenticated loopback web browser', async () => {
  const { NextRequest } = await import('next/server');
  const pairingRoute = await import('../src/app/api/pairing/route');
  const { clearDeviceRegistry } = await import('../src/lib/auth/device-registry');
  const { ensureRSAKeys } = await import('../src/lib/auth/keys');
  const { generateToken } = await import('../src/lib/auth/jwt');
  const { saveMachineSettings } = await import('../src/lib/settings/machine-settings');
  await clearDeviceRegistry();
  await ensureRSAKeys();
  await saveMachineSettings({ advertisedAddress: 'https://web-mode.example' });
  const jwt = await generateToken('persisted-user', 'persisted');
  delete process.env.TESSERA_ELECTRON_RUNTIME;

  try {
    const response = await pairingRoute.POST(new NextRequest(
      'http://localhost:32123/api/pairing',
      {
        method: 'POST',
        headers: {
          cookie: `jwt=${jwt}`,
          host: 'localhost:32123',
          origin: 'http://localhost:32123',
        },
      },
    ));
    assert.equal(response.status, 201);
    const body = await response.json() as Record<string, unknown>;
    assert.match(String(body.pairingLink), /^https:\/\/web-mode\.example\/pair#t=/);
    assert.equal(body.pairingToken, undefined);
    assert.equal(body.qrDataUrl, undefined);

    const remoteResponse = await pairingRoute.PUT(new NextRequest(
      'https://web-mode.example/api/pairing',
      {
        method: 'PUT',
        headers: {
          cookie: `jwt=${jwt}`,
          host: 'web-mode.example',
          origin: 'https://web-mode.example',
        },
      },
    ));
    assert.equal(remoteResponse.status, 403);
  } finally {
    process.env.TESSERA_ELECTRON_RUNTIME = '1';
  }
});

test('rejects absent, empty, wrong, same-length, and device-only credentials', async () => {
  const { evaluateRequest } = await import('../src/lib/auth/request-gate');
  const denied = { allow: false, reason: 'unauthorized', status: 401 };

  assert.deepEqual(await evaluateRequest(requestInput()), denied);
  assert.deepEqual(await evaluateRequest(requestInput({
    headers: { [appSecretModule.APP_SECRET_HEADER]: '' },
  })), denied);
  assert.deepEqual(await evaluateRequest(requestInput({
    headers: { [appSecretModule.APP_SECRET_HEADER]: 'wrong' },
  })), denied);
  assert.deepEqual(await evaluateRequest(requestInput({
    headers: { [appSecretModule.APP_SECRET_HEADER]: 'x'.repeat(43) },
  })), denied);
  assert.deepEqual(await evaluateRequest(requestInput({
    cookies: { device: 'registry-arrives-in-ticket-08' },
  })), denied);
});

test('uses a WebSocket policy close code instead of an HTTP status', async () => {
  const { evaluateRequest } = await import('../src/lib/auth/request-gate');

  assert.deepEqual(
    await evaluateRequest(requestInput({ purpose: 'ws-upgrade' })),
    { allow: false, reason: 'unauthorized', wsCloseCode: 1008 },
  );
});

test('rejects a credentialed WebSocket upgrade from outside the Origin allowlist', async () => {
  const secret = await appSecretModule.ensureAppSecret();
  const { evaluateRequest } = await import('../src/lib/auth/request-gate');

  assert.deepEqual(
    await evaluateRequest(requestInput({
      purpose: 'ws-upgrade',
      origin: 'http://localhost:45678',
      headers: { [appSecretModule.APP_SECRET_HEADER]: secret },
    })),
    { allow: false, reason: 'origin-not-allowed', wsCloseCode: 1008 },
  );
});

test('accepts the normalized advertised Origin for WebSocket upgrades', async () => {
  const secret = await appSecretModule.ensureAppSecret();
  const { evaluateRequest } = await import('../src/lib/auth/request-gate');
  const { saveMachineSettings } = await import('../src/lib/settings/machine-settings');
  await saveMachineSettings({
    advertisedAddress: 'https://example.ts.net:443/a/path',
  });

  assert.deepEqual(
    await evaluateRequest(requestInput({
      purpose: 'ws-upgrade',
      origin: 'https://example.ts.net',
      headers: { [appSecretModule.APP_SECRET_HEADER]: secret },
    })),
    { allow: true, userId: 'electron-local-user', kind: 'app' },
  );
});

test('direct Tailscale and LAN paths remain behind the HTTP and WebSocket gates', async () => {
  const {
    clearDeviceRegistry,
  } = await import('../src/lib/auth/device-registry');
  const { evaluateRequest } = await import('../src/lib/auth/request-gate');
  const { saveMachineSettings } = await import('../src/lib/settings/machine-settings');
  const tailscaleOrigin = 'http://100.103.66.17:32123';
  await clearDeviceRegistry();
  await saveMachineSettings({ advertisedAddress: tailscaleOrigin });
  const { device } = await pairApprovedDevice('Tailscale phone');

  assert.deepEqual(
    await evaluateRequest(requestInput({
      host: '100.103.66.17:32123',
      origin: tailscaleOrigin,
    })),
    { allow: false, reason: 'unauthorized', status: 401 },
  );
  assert.deepEqual(
    await evaluateRequest(requestInput({
      purpose: 'ws-upgrade',
      host: '100.103.66.17:32123',
      origin: tailscaleOrigin,
    })),
    { allow: false, reason: 'unauthorized', wsCloseCode: 1008 },
  );
  assert.deepEqual(
    await evaluateRequest(requestInput({
      purpose: 'ws-upgrade',
      host: '192.168.1.50:32123',
      origin: 'http://192.168.1.50:32123',
    })),
    { allow: false, reason: 'origin-not-allowed', wsCloseCode: 1008 },
  );

  const deviceCookies = { device: device.token };
  assert.equal((await evaluateRequest(requestInput({
    host: '100.103.66.17:32123',
    origin: tailscaleOrigin,
    cookies: deviceCookies,
  }))).allow, true);
  assert.equal((await evaluateRequest(requestInput({
    purpose: 'ws-upgrade',
    host: '100.103.66.17:32123',
    origin: tailscaleOrigin,
    cookies: deviceCookies,
  }))).allow, true);
});

test('always accepts both fixed-port application Origins', async () => {
  const secret = await appSecretModule.ensureAppSecret();
  const { evaluateRequest } = await import('../src/lib/auth/request-gate');

  for (const origin of ['http://localhost:32123', 'http://127.0.0.1:32123']) {
    assert.equal((await evaluateRequest(requestInput({
      purpose: 'ws-upgrade',
      origin,
      headers: { [appSecretModule.APP_SECRET_HEADER]: secret },
    }))).allow, true, origin);
  }
});

test('requires an allowed Origin only for state-changing HTTP methods', async () => {
  const secret = await appSecretModule.ensureAppSecret();
  const { evaluateRequest } = await import('../src/lib/auth/request-gate');
  const headers = { [appSecretModule.APP_SECRET_HEADER]: secret };
  const origin = 'http://localhost:45678';

  assert.deepEqual(
    await evaluateRequest(requestInput({ method: 'PUT', origin, headers })),
    { allow: false, reason: 'origin-not-allowed', status: 403 },
  );
  assert.deepEqual(
    await evaluateRequest(requestInput({ method: 'GET', origin, headers })),
    { allow: true, userId: 'electron-local-user', kind: 'app' },
  );
});

test('rejects a WebSocket upgrade without an Origin', async () => {
  const secret = await appSecretModule.ensureAppSecret();
  const { evaluateRequest } = await import('../src/lib/auth/request-gate');

  assert.deepEqual(
    await evaluateRequest(requestInput({
      purpose: 'ws-upgrade',
      origin: '',
      headers: { [appSecretModule.APP_SECRET_HEADER]: secret },
    })),
    { allow: false, reason: 'origin-not-allowed', wsCloseCode: 1008 },
  );
});

test('rejects malformed HTTP and WebSocket request targets without throwing', async () => {
  const secret = await appSecretModule.ensureAppSecret();
  const { evaluateRequest } = await import('../src/lib/auth/request-gate');
  const headers = { [appSecretModule.APP_SECRET_HEADER]: secret };

  assert.deepEqual(
    await evaluateRequest(requestInput({ headers, host: '' })),
    { allow: false, reason: 'malformed-request', status: 400 },
  );
  assert.deepEqual(
    await evaluateRequest(requestInput({
      headers,
      purpose: 'ws-upgrade',
      rawUrl: 'http://[',
    })),
    { allow: false, reason: 'malformed-request', wsCloseCode: 1008 },
  );
});

test('lets the shallow proxy check recognize any presented credential', async () => {
  const { hasPresentedCredential } = await import('../src/lib/auth/request-gate');

  assert.equal(hasPresentedCredential(requestInput()), false);
  assert.equal(hasPresentedCredential(requestInput({ cookies: { jwt: 'token' } })), true);
  assert.equal(hasPresentedCredential(requestInput({ cookies: { device: 'token' } })), true);
  assert.equal(hasPresentedCredential(requestInput({
    headers: { [appSecretModule.APP_SECRET_HEADER]: 'not-yet-validated' },
  })), true);
});
