import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';

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
    issuePairingToken,
    redeemPairingToken,
  } = await import('../src/lib/auth/device-registry');
  const { loadMachineSettings, saveMachineSettings } = await import(
    '../src/lib/settings/machine-settings'
  );
  await clearDeviceRegistry();
  await saveMachineSettings({ advertisedAddress: 'https://local-only.example' });
  const pairing = await issuePairingToken();
  const device = await redeemPairingToken(pairing.token, 'Remote phone');
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
    issuePairingToken,
    redeemPairingToken,
    revokeDevice,
  } = await import('../src/lib/auth/device-registry');
  const { evaluateRequest } = await import('../src/lib/auth/request-gate');
  const issuedAt = new Date('2026-08-03T00:00:00.000Z');
  const pairing = await issuePairingToken(issuedAt);
  const device = await redeemPairingToken(pairing.token, 'Test phone', issuedAt);
  await assert.rejects(
    () => redeemPairingToken(
      pairing.token,
      'Second phone',
      new Date(issuedAt.getTime() + PAIRING_TOKEN_TTL_MS + 1),
    ),
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

test('rejects an expired pairing token and consumes it on the first failed redemption', async () => {
  const {
    DeviceRegistryError,
    PAIRING_TOKEN_TTL_MS,
    issuePairingToken,
    redeemPairingToken,
  } = await import('../src/lib/auth/device-registry');
  const issuedAt = new Date('2026-08-03T00:00:00.000Z');
  const pairing = await issuePairingToken(issuedAt);

  await assert.rejects(
    () => redeemPairingToken(
      pairing.token,
      'Expired phone',
      new Date(issuedAt.getTime() + PAIRING_TOKEN_TTL_MS),
    ),
    (error: unknown) => error instanceof DeviceRegistryError
      && error.code === 'pairing-expired',
  );
  await assert.rejects(
    () => redeemPairingToken(
      pairing.token,
      'Expired phone',
      new Date(issuedAt.getTime() + PAIRING_TOKEN_TTL_MS + 1),
    ),
    (error: unknown) => error instanceof DeviceRegistryError
      && error.code === 'pairing-invalid',
  );
});

test('completes the pairing API flow and revokes the issued cookie immediately', async () => {
  const { NextRequest } = await import('next/server');
  const pairingRoute = await import('../src/app/api/pairing/route');
  const redeemRoute = await import('../src/app/api/pairing/redeem/route');
  const devicesRoute = await import('../src/app/api/devices/route');
  const deviceRoute = await import('../src/app/api/devices/[id]/route');
  const { clearDeviceRegistry } = await import('../src/lib/auth/device-registry');
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
  const issued = await issueResponse.json() as { pairingToken: string };

  const rotateResponse = await pairingRoute.PUT(new NextRequest(
    'http://localhost:32123/api/pairing',
    { method: 'PUT', headers: appHeaders },
  ));
  assert.equal(rotateResponse.status, 200);
  const rotated = await rotateResponse.json() as { pairingToken: string };
  assert.notEqual(rotated.pairingToken, issued.pairingToken);

  const oldTokenResponse = await redeemRoute.POST(new NextRequest(
    'http://localhost:32123/api/pairing/redeem',
    {
      method: 'POST',
      headers: appHeaders,
      body: JSON.stringify({ token: issued.pairingToken, name: 'Old phone' }),
    },
  ));
  assert.equal(oldTokenResponse.status, 401);

  const redeemResponse = await redeemRoute.POST(new NextRequest(
    'http://localhost:32123/api/pairing/redeem',
    {
      method: 'POST',
      headers: appHeaders,
      body: JSON.stringify({ token: rotated.pairingToken, name: 'Test phone' }),
    },
  ));
  assert.equal(redeemResponse.status, 201);
  const redeemed = await redeemResponse.json() as { device: { id: string; name: string } };
  assert.equal(redeemed.device.name, 'Test phone');
  const setCookie = redeemResponse.headers.get('set-cookie') ?? '';
  assert.match(setCookie, /^device=[A-Za-z0-9_-]{43};/);
  assert.match(setCookie, /HttpOnly/i);
  const deviceToken = /(?:^|;\s*)device=([^;]+)/.exec(setCookie)?.[1];
  assert.ok(deviceToken);

  const reusedTokenResponse = await redeemRoute.POST(new NextRequest(
    'http://localhost:32123/api/pairing/redeem',
    {
      method: 'POST',
      headers: appHeaders,
      body: JSON.stringify({ token: rotated.pairingToken, name: 'Reused phone' }),
    },
  ));
  assert.equal(reusedTokenResponse.status, 409);
  assert.deepEqual(await reusedTokenResponse.json(), {
    error: 'Pairing token has already been used',
    code: 'pairing-used',
  });

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

test('keeps shadow evaluation failures from changing bypass behavior', async () => {
  const backupPath = `${appSecretModule.APP_SECRET_PATH}.backup`;
  const { observeRequestGate } = await import('../src/lib/auth/request-gate');
  await rename(appSecretModule.APP_SECRET_PATH, backupPath);
  await mkdir(appSecretModule.APP_SECRET_PATH);

  try {
    await assert.doesNotReject(() => observeRequestGate(requestInput({
      headers: { [appSecretModule.APP_SECRET_HEADER]: 'z'.repeat(43) },
    })));
  } finally {
    await rm(appSecretModule.APP_SECRET_PATH, { recursive: true, force: true });
    await rename(backupPath, appSecretModule.APP_SECRET_PATH);
  }
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
