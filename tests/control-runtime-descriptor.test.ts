import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import {
  publishRuntimeDescriptor,
  readLiveRuntimeDescriptor,
} from '../src/lib/control/runtime-descriptor';

const execFileAsync = promisify(execFile);

test('a runtime descriptor is private, live, and removed with its server lifetime', async () => {
  const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'tessera-control-runtime-'));
  const runtimeDirectory = path.join(testRoot, 'runtimes');

  try {
    const handle = await publishRuntimeDescriptor({
      appVersion: '1.2.3',
      origin: 'http://127.0.0.1:32123',
      runtimeDirectory,
    });

    assert.equal(handle.descriptor.pid, process.pid);
    assert.equal(handle.descriptor.appVersion, '1.2.3');
    assert.equal(handle.descriptor.controlApiVersion, 1);
    assert.equal(Buffer.from(handle.descriptor.token, 'base64url').byteLength, 32);
    assert.notEqual(handle.descriptor.runtimeId, handle.descriptor.token);

    const live = await readLiveRuntimeDescriptor(handle.path);
    assert.deepEqual(live, handle.descriptor);

    if (process.platform !== 'win32') {
      assert.equal((await fs.stat(runtimeDirectory)).mode & 0o777, 0o700);
      assert.equal((await fs.stat(handle.path)).mode & 0o777, 0o600);
    }

    await handle.cleanup();
    await assert.rejects(fs.access(handle.path));
  } finally {
    await fs.rm(testRoot, { recursive: true, force: true });
  }
});

test('a descriptor for a stopped process is rejected as unavailable', async () => {
  const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'tessera-control-stale-'));
  const descriptorPath = path.join(testRoot, 'runtime.json');

  try {
    await fs.chmod(testRoot, 0o700);
    await fs.writeFile(descriptorPath, JSON.stringify({
      runtimeId: 'runtime-stale',
      pid: 2_147_483_647,
      appVersion: '1.2.3',
      controlApiVersion: 1,
      origin: 'http://127.0.0.1:32123',
      token: Buffer.alloc(32, 7).toString('base64url'),
    }), { mode: 0o600 });

    await assert.rejects(
      readLiveRuntimeDescriptor(descriptorPath),
      (error: Error & { code?: string }) => error.code === 'INSTANCE_UNAVAILABLE',
    );
  } finally {
    await fs.rm(testRoot, { recursive: true, force: true });
  }
});

test('a POSIX descriptor readable by another OS user is rejected', {
  skip: process.platform === 'win32',
}, async () => {
  const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'tessera-control-insecure-'));
  const handle = await publishRuntimeDescriptor({
    appVersion: '1.2.3',
    origin: 'http://127.0.0.1:32123',
    runtimeDirectory: path.join(testRoot, 'runtimes'),
  });

  try {
    await fs.chmod(handle.path, 0o644);
    await assert.rejects(
      readLiveRuntimeDescriptor(handle.path),
      (error: Error & { code?: string }) => error.code === 'INSTANCE_UNAVAILABLE',
    );
  } finally {
    await handle.cleanup();
    await fs.rm(testRoot, { recursive: true, force: true });
  }
});

test('a live runtime descriptor path cannot be replaced by a neighboring server', async () => {
  const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'tessera-control-owned-'));
  const descriptorPath = path.join(testRoot, 'runtime.json');
  const owner = await publishRuntimeDescriptor({
    appVersion: '1.2.3',
    origin: 'http://127.0.0.1:32123',
    descriptorPath,
  });

  try {
    await assert.rejects(publishRuntimeDescriptor({
      appVersion: '1.2.3',
      origin: 'http://127.0.0.1:32124',
      descriptorPath,
    }));
    assert.equal((await readLiveRuntimeDescriptor(descriptorPath)).runtimeId, owner.descriptor.runtimeId);
  } finally {
    await owner.cleanup();
    await fs.rm(testRoot, { recursive: true, force: true });
  }
});

test('Windows descriptor ACLs grant access only to the current OS user', {
  skip: process.platform !== 'win32',
}, async () => {
  const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'tessera-control-windows-acl-'));
  const handle = await publishRuntimeDescriptor({
    appVersion: '1.2.3',
    origin: 'http://127.0.0.1:32123',
    runtimeDirectory: path.join(testRoot, 'runtimes'),
  });

  try {
    const script = [
      '$currentAccount = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name',
      '$results = foreach ($targetPath in @($env:TESSERA_TEST_ACL_FILE, $env:TESSERA_TEST_ACL_PARENT)) {',
      '  $acl = Get-Acl -LiteralPath $targetPath',
      '  $accounts = @($acl.Access | ForEach-Object { $_.IdentityReference.Value } | Sort-Object -Unique)',
      '  [pscustomobject]@{ protected = $acl.AreAccessRulesProtected; currentOnly = ($accounts.Count -eq 1 -and $accounts[0] -eq $currentAccount) }',
      '}',
      '$results | ConvertTo-Json -Compress',
    ].join('; ');
    const { stdout } = await execFileAsync('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script,
    ], {
      env: {
        ...process.env,
        TESSERA_TEST_ACL_FILE: handle.path,
        TESSERA_TEST_ACL_PARENT: path.dirname(handle.path),
      },
      windowsHide: true,
    });
    const results = JSON.parse(stdout) as Array<{ protected: boolean; currentOnly: boolean }>;
    assert.deepEqual(results, [
      { protected: true, currentOnly: true },
      { protected: true, currentOnly: true },
    ]);
  } finally {
    await handle.cleanup();
    await fs.rm(testRoot, { recursive: true, force: true });
  }
});
