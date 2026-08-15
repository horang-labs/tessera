import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import test, { after, before, beforeEach } from 'node:test';

const execFileAsync = promisify(execFile);

let tempDir: string;
const previousDataDir = process.env.TESSERA_DATA_DIR;

before(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), 'tessera-pairing-approval-'));
  process.env.TESSERA_DATA_DIR = tempDir;
});

beforeEach(async () => {
  const registry = await import('../src/lib/auth/device-registry');
  await registry.clearDeviceRegistry();
});

after(async () => {
  if (previousDataDir === undefined) delete process.env.TESSERA_DATA_DIR;
  else process.env.TESSERA_DATA_DIR = previousDataDir;
  await rm(tempDir, { recursive: true, force: true });
});

test('claiming a QR creates one authenticated pending request without registering a device', async () => {
  const registry = await import('../src/lib/auth/device-registry');
  const issuedAt = new Date('2026-08-05T00:00:00.000Z');
  const pairing = await registry.issuePairingToken(issuedAt);
  const claimedAt = new Date(issuedAt.getTime() + 1_000);

  const first = await registry.claimPairingToken({
    token: pairing.token,
    name: 'Travel phone',
    browser: 'Mobile Safari',
    platform: 'iOS',
    remoteAddress: '100.64.0.8',
  }, undefined, claimedAt);

  assert.match(first.pollingCredential, /^[A-Za-z0-9_-]{43}$/);
  assert.match(first.request.id, /^[0-9a-f-]{36}$/);
  assert.match(first.request.comparisonCode, /^\d{6}$/);
  assert.equal(first.request.expiresAt, pairing.expiresAt);
  assert.equal(first.request.status, 'pending');
  assert.equal(first.created, true);
  assert.deepEqual(await registry.listDevices(), []);
  assert.deepEqual(await registry.listPairingRequests(claimedAt), [first.request]);

  const retry = await registry.claimPairingToken({
    token: pairing.token,
    name: 'A changed client label must not replace the original',
    browser: 'Unknown',
    platform: 'Unknown',
    remoteAddress: '100.64.0.99',
  }, first.pollingCredential, claimedAt);
  assert.equal(retry.created, false);
  assert.deepEqual(retry, { ...first, created: false });

  await assert.rejects(
    () => registry.claimPairingToken({
      token: pairing.token,
      name: 'Second browser',
      browser: 'Chrome',
      platform: 'Android',
      remoteAddress: '100.64.0.9',
    }, undefined, claimedAt),
    (error: unknown) => error instanceof registry.DeviceRegistryError
      && error.code === 'pairing-used',
  );

  const persisted = JSON.parse(await readFile(registry.getDeviceRegistryPath(), 'utf8'));
  assert.equal('pendingPairingRequests' in persisted, false, 'pending requests must stay in memory');
  assert.equal(JSON.stringify(persisted).includes(first.pollingCredential), false);
});

test('only an approved request can atomically mint one device credential', async () => {
  const registry = await import('../src/lib/auth/device-registry');
  const issuedAt = new Date('2026-08-05T01:00:00.000Z');
  const pairing = await registry.issuePairingToken(issuedAt);
  const claim = await registry.claimPairingToken({
    token: pairing.token,
    name: 'Travel phone',
    browser: 'Mobile Safari',
    platform: 'iOS',
    remoteAddress: '100.64.0.8',
  }, undefined, issuedAt);

  assert.deepEqual(
    await registry.receivePairingDecision(
      claim.request.id,
      claim.pollingCredential,
      issuedAt,
    ),
    { status: 'pending', expiresAt: pairing.expiresAt },
  );

  const approved = await registry.decidePairingRequest(
    claim.request.id,
    'approve',
    new Date(issuedAt.getTime() + 1_000),
  );
  assert.equal(approved.status, 'approved');
  assert.equal('pollingCredential' in approved, false);

  const outcomes = await Promise.all([
    registry.receivePairingDecision(
      claim.request.id,
      claim.pollingCredential,
      new Date(issuedAt.getTime() + 2_000),
    ),
    registry.receivePairingDecision(
      claim.request.id,
      claim.pollingCredential,
      new Date(issuedAt.getTime() + 2_000),
    ),
  ]);
  const redeemed = outcomes.find((outcome) => outcome.status === 'redeemed');
  const duplicate = outcomes.find((outcome) => outcome.status === 'used');
  assert.ok(redeemed && redeemed.status === 'redeemed');
  assert.ok(duplicate);
  assert.match(redeemed.device.token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal((await registry.listDevices()).length, 1);
  assert.equal(
    (await registry.resolveDeviceToken(redeemed.device.token))?.id,
    redeemed.device.id,
  );

  assert.equal(
    (await registry.receivePairingDecision(
      claim.request.id,
      'x'.repeat(43),
      new Date(issuedAt.getTime() + 2_000),
    )).status,
    'expired',
  );
});

test('denial, expiry, and QR rotation all finish fail-closed without ghost devices', async () => {
  const registry = await import('../src/lib/auth/device-registry');
  const issuedAt = new Date('2026-08-05T02:00:00.000Z');

  const deniedPairing = await registry.issuePairingToken(issuedAt);
  const denied = await registry.claimPairingToken({
    token: deniedPairing.token,
    name: 'Denied phone',
    browser: 'Chrome',
    platform: 'Android',
    remoteAddress: '100.64.0.9',
  }, undefined, issuedAt);
  await registry.decidePairingRequest(denied.request.id, 'deny', issuedAt);
  assert.deepEqual(
    await registry.receivePairingDecision(
      denied.request.id,
      denied.pollingCredential,
      issuedAt,
    ),
    { status: 'denied', expiresAt: deniedPairing.expiresAt },
  );

  const rotatedPairing = await registry.rotatePairingToken(
    new Date(issuedAt.getTime() + 10_000),
  );
  const rotated = await registry.claimPairingToken({
    token: rotatedPairing.token,
    name: 'Rotated phone',
    browser: 'Firefox',
    platform: 'Linux',
    remoteAddress: '100.64.0.10',
  }, undefined, new Date(issuedAt.getTime() + 11_000));
  await registry.rotatePairingToken(new Date(issuedAt.getTime() + 12_000));
  assert.deepEqual(
    await registry.receivePairingDecision(
      rotated.request.id,
      rotated.pollingCredential,
      new Date(issuedAt.getTime() + 12_000),
    ),
    { status: 'expired', expiresAt: rotatedPairing.expiresAt },
  );
  await assert.rejects(
    () => registry.decidePairingRequest(rotated.request.id, 'approve', issuedAt),
    (error: unknown) => error instanceof registry.DeviceRegistryError
      && error.code === 'pairing-expired',
  );

  const expiringPairing = await registry.rotatePairingToken(
    new Date(issuedAt.getTime() + 20_000),
  );
  const expiring = await registry.claimPairingToken({
    token: expiringPairing.token,
    name: 'Slow phone',
    browser: 'Safari',
    platform: 'macOS',
    remoteAddress: '100.64.0.11',
  }, undefined, new Date(issuedAt.getTime() + 21_000));
  const expiredAt = new Date(Date.parse(expiringPairing.expiresAt));
  assert.deepEqual(
    await registry.receivePairingDecision(
      expiring.request.id,
      expiring.pollingCredential,
      expiredAt,
    ),
    { status: 'expired', expiresAt: expiringPairing.expiresAt },
  );
  await assert.rejects(
    () => registry.decidePairingRequest(expiring.request.id, 'approve', expiredAt),
    (error: unknown) => error instanceof registry.DeviceRegistryError
      && error.code === 'pairing-expired',
  );
  assert.deepEqual(await registry.listDevices(), []);
});

test('concurrent scans and conflicting local decisions have one winner', async () => {
  const registry = await import('../src/lib/auth/device-registry');
  const now = new Date('2026-08-05T03:00:00.000Z');
  const pairing = await registry.issuePairingToken(now);
  const metadata = {
    token: pairing.token,
    name: 'Contended phone',
    browser: 'Chrome',
    platform: 'Android',
    remoteAddress: '100.64.0.12',
  };

  const claims = await Promise.allSettled([
    registry.claimPairingToken(metadata, undefined, now),
    registry.claimPairingToken(metadata, undefined, now),
  ]);
  assert.equal(claims.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(claims.filter((result) => (
    result.status === 'rejected'
    && result.reason instanceof registry.DeviceRegistryError
    && result.reason.code === 'pairing-used'
  )).length, 1);

  const winner = claims.find((result) => result.status === 'fulfilled');
  assert.ok(winner && winner.status === 'fulfilled');
  const decisions = await Promise.allSettled([
    registry.decidePairingRequest(winner.value.request.id, 'approve', now),
    registry.decidePairingRequest(winner.value.request.id, 'deny', now),
  ]);
  assert.equal(decisions.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(decisions.filter((result) => result.status === 'rejected').length, 1);
});

test('a server restart forgets pending requests and cannot redeem their polling cookies', async () => {
  const registryUrl = pathToFileURL(
    path.join(process.cwd(), 'src/lib/auth/device-registry.ts'),
  ).href;
  const tsxExecutable = path.join(
    process.cwd(),
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'tsx.cmd' : 'tsx',
  );
  const childEnvironment = { ...process.env, TESSERA_DATA_DIR: tempDir };
  const createScript = `
    void (async () => {
      const imported = await import(${JSON.stringify(registryUrl)});
      const registry = imported.default ?? imported;
      await registry.clearDeviceRegistry();
      const now = new Date('2026-08-05T04:00:00.000Z');
      const pairing = await registry.issuePairingToken(now);
      const claim = await registry.claimPairingToken({
        token: pairing.token,
        name: 'Restarted phone',
        browser: 'Chrome',
        platform: 'Android',
        remoteAddress: '100.64.0.13',
      }, undefined, now);
      process.stdout.write(JSON.stringify({
        requestId: claim.request.id,
        pollingCredential: claim.pollingCredential,
      }));
    })();
  `;
  const created = await execFileAsync(
    tsxExecutable,
    ['--eval', createScript],
    { cwd: process.cwd(), env: childEnvironment },
  );
  const pending = JSON.parse(created.stdout) as {
    requestId: string;
    pollingCredential: string;
  };

  const receiveScript = `
    void (async () => {
      const imported = await import(${JSON.stringify(registryUrl)});
      const registry = imported.default ?? imported;
      const result = await registry.receivePairingDecision(
        ${JSON.stringify(pending.requestId)},
        ${JSON.stringify(pending.pollingCredential)},
        new Date('2026-08-05T04:00:01.000Z'),
      );
      process.stdout.write(JSON.stringify({ result, devices: await registry.listDevices() }));
    })();
  `;
  const restarted = await execFileAsync(
    tsxExecutable,
    ['--eval', receiveScript],
    { cwd: process.cwd(), env: childEnvironment },
  );
  assert.deepEqual(JSON.parse(restarted.stdout), {
    result: { status: 'expired', expiresAt: '2026-08-05T04:00:01.000Z' },
    devices: [],
  });
});
