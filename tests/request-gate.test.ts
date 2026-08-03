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
let appSecretModule: typeof import('../src/lib/auth/app-secret');

before(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), 'tessera-request-gate-'));
  process.env.TESSERA_DATA_DIR = tempDir;
  process.env.TESSERA_ELECTRON_RUNTIME = '1';
  process.env.AUTH_KEYS_DIR = path.join(tempDir, 'auth');
  process.env.USERS_FILE_PATH = path.join(tempDir, 'users.json');
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
  await rm(tempDir, { recursive: true, force: true });
});

function requestInput({
  headers = {},
  cookies = {},
  purpose = 'http',
  rawUrl = '/api/projects',
  host = 'localhost:32123',
}: {
  headers?: Record<string, string>;
  cookies?: Record<string, string>;
  purpose?: 'http' | 'ws-upgrade';
  rawUrl?: string;
  host?: string;
} = {}) {
  return {
    purpose,
    method: 'GET',
    rawUrl,
    host,
    origin: 'http://localhost:32123',
    cookies,
    headers,
  };
}

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
