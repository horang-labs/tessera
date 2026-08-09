import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  MobileAccessCoordinator,
  type TailscaleAdapter,
  type TailscaleNodeStatus,
  type TailscaleServeEndpoint,
} from '../src/lib/mobile-access/mobile-access-coordinator';
import {
  FileMobileAccessStateStore,
  MOBILE_ACCESS_OWNER,
  type MobileAccessOwnership,
  type MobileAccessStateStore,
} from '../src/lib/mobile-access/mobile-access-state-store';

test('setup exposes configuring and reaches ready only after verified Serve and HTTPS health', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'tessera-mobile-access-'));
  const statePath = path.join(tempDir, 'machine', 'mobile-access.json');
  const calls: string[] = [];
  let configuredEndpoint: TailscaleServeEndpoint | null = null;
  let releaseConfigure!: () => void;
  const configureGate = new Promise<void>((resolve) => {
    releaseConfigure = resolve;
  });

  const node: TailscaleNodeStatus = {
    connected: true,
    dnsName: 'desktop.tailnet.ts.net',
    httpsReady: true,
  };
  const adapter: TailscaleAdapter = {
    async inspectNode() {
      calls.push('inspect-node');
      return node;
    },
    async inspectServe() {
      calls.push('inspect-serve');
      return configuredEndpoint;
    },
    async configureServe(endpoint) {
      calls.push('configure-serve');
      await configureGate;
      configuredEndpoint = endpoint;
    },
  };
  const coordinator = new MobileAccessCoordinator({
    adapter,
    stateStore: new FileMobileAccessStateStore(statePath),
    async checkHealth(origin) {
      calls.push(`health:${origin}`);
    },
    async publishPairingOrigin(origin) {
      calls.push(`publish:${origin}`);
    },
  });

  try {
    assert.deepEqual(await coordinator.getStatus(), { state: 'not-configured' });

    const setup = coordinator.setup({ loopbackPort: 32_123 });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(await coordinator.getStatus(), { state: 'configuring' });

    releaseConfigure();
    assert.deepEqual(await setup, {
      state: 'ready',
      origin: 'https://desktop.tailnet.ts.net',
    });

    assert.deepEqual(calls, [
      'inspect-node',
      'inspect-serve',
      'configure-serve',
      'inspect-serve',
      'health:https://desktop.tailnet.ts.net',
      'publish:https://desktop.tailnet.ts.net',
    ]);
    assert.deepEqual(JSON.parse(await readFile(statePath, 'utf8')), {
      schemaVersion: 1,
      owner: MOBILE_ACCESS_OWNER,
      nodeDnsName: 'desktop.tailnet.ts.net',
      origin: 'https://desktop.tailnet.ts.net',
      servePort: 443,
      mountPath: '/',
      lastLoopbackTarget: 'http://127.0.0.1:32123',
    });
    assert.equal((await stat(statePath)).mode & 0o777, 0o600);
    assert.equal((await stat(path.dirname(statePath))).mode & 0o777, 0o700);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('a failed HTTPS health check stays not configured without publishing pairing access', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'tessera-mobile-access-failure-'));
  const statePath = path.join(tempDir, 'mobile-access.json');
  let configuredEndpoint: TailscaleServeEndpoint | null = null;
  let publishCount = 0;
  const coordinator = new MobileAccessCoordinator({
    adapter: {
      async inspectNode() {
        return {
          connected: true,
          dnsName: 'desktop.tailnet.ts.net',
          httpsReady: true,
        };
      },
      async inspectServe() {
        return configuredEndpoint;
      },
      async configureServe(endpoint) {
        configuredEndpoint = endpoint;
      },
    },
    stateStore: new FileMobileAccessStateStore(statePath),
    async checkHealth() {
      throw new Error('TLS endpoint did not reach Tessera');
    },
    async publishPairingOrigin() {
      publishCount += 1;
    },
  });

  try {
    assert.deepEqual(await coordinator.setup({ loopbackPort: 32_123 }), {
      state: 'not-configured',
      error: {
        code: 'setup-failed',
        message: 'TLS endpoint did not reach Tessera',
      },
    });
    assert.equal(publishCount, 0);
    await assert.rejects(readFile(statePath), { code: 'ENOENT' });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('restoring owned Serve republishes its pairing origin before reporting ready', async () => {
  const ownership: MobileAccessOwnership = {
    schemaVersion: 1,
    owner: MOBILE_ACCESS_OWNER,
    nodeDnsName: 'desktop.tailnet.ts.net',
    origin: 'https://desktop.tailnet.ts.net',
    servePort: 443,
    mountPath: '/',
    lastLoopbackTarget: 'http://127.0.0.1:32123',
  };
  let publishAttempts = 0;
  const coordinator = new MobileAccessCoordinator({
    adapter: {
      async inspectNode() {
        return { connected: true, dnsName: ownership.nodeDnsName, httpsReady: true };
      },
      async inspectServe() {
        return {
          dnsName: ownership.nodeDnsName,
          port: 443,
          mountPath: '/',
          proxyTarget: ownership.lastLoopbackTarget,
        };
      },
      async configureServe() {
        assert.fail('restoring status must not reconfigure a verified endpoint');
      },
    },
    stateStore: { async load() { return ownership; }, async save() {} },
    async checkHealth() {},
    async publishPairingOrigin() {
      publishAttempts += 1;
      if (publishAttempts === 1) throw new Error('settings publication failed');
    },
  });

  assert.deepEqual(await coordinator.getStatus(), {
    state: 'not-configured',
    error: { code: 'setup-failed', message: 'settings publication failed' },
  });
  assert.deepEqual(await coordinator.getStatus(), {
    state: 'ready',
    origin: ownership.origin,
  });
  assert.equal(publishAttempts, 2);
});

test('setup refuses to overwrite a Serve root that no longer matches persisted ownership', async () => {
  const ownership: MobileAccessOwnership = {
    schemaVersion: 1,
    owner: MOBILE_ACCESS_OWNER,
    nodeDnsName: 'desktop.tailnet.ts.net',
    origin: 'https://desktop.tailnet.ts.net',
    servePort: 443,
    mountPath: '/',
    lastLoopbackTarget: 'http://127.0.0.1:32122',
  };
  let configureCount = 0;
  const stateStore: MobileAccessStateStore = {
    async load() { return ownership; },
    async save() {},
  };
  const coordinator = new MobileAccessCoordinator({
    adapter: {
      async inspectNode() {
        return { connected: true, dnsName: ownership.nodeDnsName, httpsReady: true };
      },
      async inspectServe() {
        return {
          dnsName: ownership.nodeDnsName,
          port: 443,
          mountPath: '/',
          proxyTarget: 'http://127.0.0.1:9999',
        };
      },
      async configureServe() { configureCount += 1; },
    },
    stateStore,
    async checkHealth() {},
    async publishPairingOrigin() {},
  });

  assert.deepEqual(await coordinator.setup({ loopbackPort: 32_123 }), {
    state: 'not-configured',
    error: {
      code: 'serve-root-in-use',
      message: 'Tailscale HTTPS port 443 root is already in use',
    },
  });
  assert.equal(configureCount, 0);
});

test('Windows persistence applies current-user ACLs before atomically publishing state', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'tessera-mobile-access-acl-'));
  const statePath = path.join(tempDir, 'machine', 'mobile-access.json');
  const protectedPaths: Array<{ targetPath: string; directory: boolean }> = [];
  const store = new FileMobileAccessStateStore(statePath, {
    platform: 'win32',
    async restrictWindowsPath(targetPath, directory) {
      protectedPaths.push({ targetPath, directory });
    },
  });
  const ownership: MobileAccessOwnership = {
    schemaVersion: 1,
    owner: MOBILE_ACCESS_OWNER,
    nodeDnsName: 'desktop.tailnet.ts.net',
    origin: 'https://desktop.tailnet.ts.net',
    servePort: 443,
    mountPath: '/',
    lastLoopbackTarget: 'http://127.0.0.1:32123',
  };

  try {
    await store.save(ownership);
    assert.equal(protectedPaths[0]?.targetPath, path.dirname(statePath));
    assert.equal(protectedPaths[0]?.directory, true);
    assert.match(protectedPaths[1]?.targetPath ?? '', /\.mobile-access\..+\.tmp$/);
    assert.equal(protectedPaths[1]?.directory, false);
    assert.equal(protectedPaths[2]?.targetPath, statePath);
    assert.equal(protectedPaths[2]?.directory, false);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
