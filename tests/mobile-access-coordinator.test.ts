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
