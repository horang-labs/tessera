import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';

let tempDir: string;
const previousDataDir = process.env.TESSERA_DATA_DIR;

before(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), 'tessera-device-registry-'));
  process.env.TESSERA_DATA_DIR = tempDir;
});

after(async () => {
  if (previousDataDir === undefined) delete process.env.TESSERA_DATA_DIR;
  else process.env.TESSERA_DATA_DIR = previousDataDir;
  await rm(tempDir, { recursive: true, force: true });
});

test('stores a private atomic registry, enforces the device cap, and clears every device', async () => {
  const registry = await import('../src/lib/auth/device-registry');
  await registry.clearDeviceRegistry();

  for (let index = 0; index < registry.MAX_PAIRED_DEVICES; index += 1) {
    const pairing = await registry.issuePairingToken();
    await registry.redeemPairingToken(pairing.token, `Device ${index + 1}`);
  }

  const devices = await registry.listDevices();
  assert.equal(devices.length, registry.MAX_PAIRED_DEVICES);
  assert.ok(devices.every((device) => !('token' in device)));
  assert.equal((await stat(registry.getDeviceRegistryPath())).mode & 0o777, 0o600);
  assert.deepEqual(
    (await readdir(path.dirname(registry.getDeviceRegistryPath())))
      .filter((name) => name.endsWith('.tmp')),
    [],
  );
  await assert.rejects(
    () => registry.issuePairingToken(),
    (error: unknown) => error instanceof registry.DeviceRegistryError
      && error.code === 'capacity-reached',
  );

  const revokedIds = await registry.clearDeviceRegistry();
  assert.equal(revokedIds.length, registry.MAX_PAIRED_DEVICES);
  assert.deepEqual(await registry.listDevices(), []);
});
