import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  MOBILE_ACCESS_HTTPS_PORT_CANDIDATES,
  MobileAccessCoordinator,
  type TailscaleAdapter,
  type TailscaleConfigureResult,
  type TailscaleNodeStatus,
  type TailscaleServeEndpoint,
  type TailscaleServeStatus,
} from '../src/lib/mobile-access/mobile-access-coordinator';
import {
  FileMobileAccessStateStore,
  MOBILE_ACCESS_OWNER,
  type MobileAccessPersistedState,
  type MobileAccessStateStore,
} from '../src/lib/mobile-access/mobile-access-state-store';

const DNS_NAME = 'desktop.tailnet.ts.net';
const LOOPBACK_PORT = 32_123;
const LOOPBACK_TARGET = `http://127.0.0.1:${LOOPBACK_PORT}`;

function emptyServe(): TailscaleServeStatus {
  return { endpoints: [], occupiedPorts: [], resources: [] };
}

function ownedServe(
  proxyTarget = LOOPBACK_TARGET,
  dnsName = DNS_NAME,
  port = 443,
): TailscaleServeStatus {
  return {
    endpoints: [{
      dnsName,
      port,
      mountPath: '/',
      proxyTarget,
      scope: 'background',
    }],
    occupiedPorts: [port],
    resources: [
      { key: `background:tcp:${port}`, value: '{"HTTPS":true}' },
      {
        key: `background:web:${dnsName}:${port}:/`,
        value: `{"Proxy":"${proxyTarget}"}`,
      },
    ],
  };
}

class MemoryStateStore implements MobileAccessStateStore {
  state: MobileAccessPersistedState | null = null;
  readonly saves: MobileAccessPersistedState[] = [];

  async load(): Promise<MobileAccessPersistedState | null> {
    return this.state ? structuredClone(this.state) : null;
  }

  async save(state: MobileAccessPersistedState): Promise<void> {
    this.state = structuredClone(state);
    this.saves.push(structuredClone(state));
  }
}

function createHarness(options: {
  node?: TailscaleNodeStatus;
  serve?: TailscaleServeStatus;
  configureResult?: TailscaleConfigureResult;
  configureError?: Error | null;
  configureGate?: Promise<void>;
  inspectServeGate?: Promise<void>;
} = {}) {
  const calls: string[] = [];
  const opened: string[] = [];
  const store = new MemoryStateStore();
  let node: TailscaleNodeStatus = options.node ?? {
    state: 'running',
    dnsName: DNS_NAME,
    httpsReady: true,
  };
  let serve = structuredClone(options.serve ?? emptyServe());
  let configureResult: TailscaleConfigureResult = options.configureResult
    ?? { state: 'configured' };
  let configureError = options.configureError ?? null;

  const adapter: TailscaleAdapter = {
    async inspectNode() {
      calls.push('inspect-node');
      return structuredClone(node);
    },
    async requestSignIn() {
      calls.push('request-sign-in');
      return 'https://login.tailscale.com/a/generated';
    },
    async inspectServe() {
      calls.push('inspect-serve');
      await options.inspectServeGate;
      return structuredClone(serve);
    },
    async configureServe(endpoint) {
      calls.push(`configure:${endpoint.port}`);
      await options.configureGate;
      if (configureError) throw configureError;
      if (configureResult.state === 'authorization-required') return configureResult;
      const endpointKey = `background:web:${endpoint.dnsName}:${endpoint.port}:/`;
      serve.endpoints = [
        ...serve.endpoints.filter((candidate) => !(
          candidate.scope !== 'foreground'
          && candidate.scope !== 'service'
          && candidate.dnsName === endpoint.dnsName
          && candidate.port === endpoint.port
          && candidate.mountPath === '/'
        )),
        structuredClone(endpoint),
      ];
      serve.occupiedPorts = [...new Set([...serve.occupiedPorts, endpoint.port])]
        .sort((left, right) => left - right);
      serve.resources = [
        ...serve.resources.filter((resource) => (
          resource.key !== `background:tcp:${endpoint.port}`
          && resource.key !== endpointKey
        )),
        { key: `background:tcp:${endpoint.port}`, value: '{"HTTPS":true}' },
        { key: endpointKey, value: `{"Proxy":"${endpoint.proxyTarget}"}` },
      ].sort((left, right) => left.key.localeCompare(right.key));
      return configureResult;
    },
  };
  const coordinator = new MobileAccessCoordinator({
    adapter,
    stateStore: store,
    async checkHealth(origin) { calls.push(`health:${origin}`); },
    async openExternal(url) { opened.push(url); },
  });

  return {
    adapter,
    calls,
    coordinator,
    opened,
    store,
    setConfigureResult(value: TailscaleConfigureResult) { configureResult = value; },
    setConfigureError(value: Error | null) { configureError = value; },
    setNode(value: TailscaleNodeStatus) { node = value; },
    setServe(value: TailscaleServeStatus) { serve = structuredClone(value); },
    serve: () => structuredClone(serve),
  };
}

function rememberCompletedSetup(
  store: MemoryStateStore,
  overrides: Partial<MobileAccessPersistedState> = {},
): void {
  store.state = {
    schemaVersion: 1,
    owner: MOBILE_ACCESS_OWNER,
    nodeDnsName: DNS_NAME,
    origin: `https://${DNS_NAME}`,
    servePort: 443,
    mountPath: '/',
    lastLoopbackTarget: LOOPBACK_TARGET,
    ...overrides,
  } as MobileAccessPersistedState;
}

test('launch reconciliation leaves a current owned mapping unchanged', async () => {
  const harness = createHarness({ serve: ownedServe() });
  rememberCompletedSetup(harness.store);

  assert.deepEqual(
    await harness.coordinator.reconcileOnLaunch({ loopbackPort: LOOPBACK_PORT }),
    { state: 'ready', origin: `https://${DNS_NAME}` },
  );
  assert.deepEqual(harness.calls, [
    'inspect-node',
    'inspect-serve',
    `health:https://${DNS_NAME}`,
  ]);
  assert.equal(harness.store.saves.length, 0);
});

test('launch reconciliation does not finish before Serve inspection is ready', async () => {
  let releaseInspection!: () => void;
  const inspectServeGate = new Promise<void>((resolve) => { releaseInspection = resolve; });
  const harness = createHarness({ serve: ownedServe(), inspectServeGate });
  rememberCompletedSetup(harness.store);

  let settled = false;
  const reconciliation = harness.coordinator
    .reconcileOnLaunch({ loopbackPort: LOOPBACK_PORT })
    .finally(() => { settled = true; });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(harness.calls, ['inspect-node', 'inspect-serve']);
  assert.equal(settled, false);
  releaseInspection();
  assert.deepEqual(await reconciliation, {
    state: 'ready',
    origin: `https://${DNS_NAME}`,
  });
});

test('launch reconciliation repairs only the owned backend target and preserves its origin', async () => {
  const nextLoopbackPort = LOOPBACK_PORT + 1;
  const nextLoopbackTarget = `http://127.0.0.1:${nextLoopbackPort}`;
  const serve = ownedServe();
  const unrelatedResource = {
    key: 'background:web:desktop.tailnet.ts.net:8443:/other',
    value: '{"Text":"unrelated"}',
  };
  serve.resources.push(unrelatedResource);
  const harness = createHarness({ serve });
  rememberCompletedSetup(harness.store);

  assert.deepEqual(
    await harness.coordinator.reconcileOnLaunch({ loopbackPort: nextLoopbackPort }),
    { state: 'ready', origin: `https://${DNS_NAME}` },
  );
  assert.equal(harness.calls.includes('configure:443'), true);
  assert.equal(harness.serve().endpoints[0]?.proxyTarget, nextLoopbackTarget);
  assert.deepEqual(
    harness.serve().resources.find((resource) => resource.key === unrelatedResource.key),
    unrelatedResource,
  );
  assert.deepEqual(harness.store.state, {
    schemaVersion: 1,
    owner: MOBILE_ACCESS_OWNER,
    nodeDnsName: DNS_NAME,
    origin: `https://${DNS_NAME}`,
    servePort: 443,
    mountPath: '/',
    lastLoopbackTarget: nextLoopbackTarget,
  });
});

test('launch reconciliation recreates an absent owned mapping at its persisted origin', async () => {
  const harness = createHarness({ serve: emptyServe() });
  rememberCompletedSetup(harness.store);

  assert.deepEqual(
    await harness.coordinator.reconcileOnLaunch({ loopbackPort: LOOPBACK_PORT }),
    { state: 'ready', origin: `https://${DNS_NAME}` },
  );
  assert.equal(harness.calls.includes('configure:443'), true);
  assert.deepEqual(harness.serve().endpoints, ownedServe().endpoints);
  assert.equal(harness.store.saves.length, 0);
});

test('launch reconciliation reports ownership loss without overwriting an unrecognized target', async () => {
  const harness = createHarness({ serve: ownedServe('http://127.0.0.1:45678') });
  rememberCompletedSetup(harness.store);

  assert.deepEqual(
    await harness.coordinator.reconcileOnLaunch({ loopbackPort: LOOPBACK_PORT + 1 }),
    {
      state: 'ownership-conflict',
      message: 'The Tessera-owned Tailscale Serve endpoint changed',
    },
  );
  assert.equal(harness.calls.some((call) => call.startsWith('configure:')), false);
  assert.equal(harness.store.saves.length, 0);
});

test('configured mobile access is temporarily unavailable while Tailscale cannot serve', async () => {
  const cases: Array<{
    node: TailscaleNodeStatus;
    reason: 'missing' | 'signed-out' | 'stopped';
    message: string;
  }> = [
    { node: { state: 'missing' }, reason: 'missing', message: 'Tailscale is not installed' },
    { node: { state: 'needs-login' }, reason: 'signed-out', message: 'Tailscale is signed out' },
    { node: { state: 'stopped' }, reason: 'stopped', message: 'Tailscale is stopped' },
  ];

  for (const { node, reason, message } of cases) {
    const harness = createHarness({ node });
    rememberCompletedSetup(harness.store);
    assert.deepEqual(
      await harness.coordinator.reconcileOnLaunch({ loopbackPort: LOOPBACK_PORT }),
      { state: 'temporarily-unavailable', reason, message },
    );
    assert.equal(harness.store.saves.length, 0);
  }
});

test('launch recognizes persisted mobile configuration while Tailscale is unavailable', async () => {
  const harness = createHarness({ node: { state: 'stopped' } });
  rememberCompletedSetup(harness.store);

  await harness.coordinator.reconcileOnLaunch({ loopbackPort: LOOPBACK_PORT });

  assert.equal(harness.coordinator.hasConfiguredConnection(), true);
});

test('launch reconciliation requires removal and fresh setup when the public origin changed', async () => {
  const harness = createHarness({
    node: { state: 'running', dnsName: 'desktop.changed-tailnet.ts.net', httpsReady: true },
  });
  rememberCompletedSetup(harness.store);

  assert.deepEqual(
    await harness.coordinator.reconcileOnLaunch({ loopbackPort: LOOPBACK_PORT }),
    {
      state: 'ownership-conflict',
      reason: 'origin-changed',
      message: 'The Tailscale node or tailnet domain changed. Remove the mobile connection, then set it up again.',
    },
  );
  assert.equal(harness.calls.includes('inspect-serve'), false);
  assert.equal(harness.calls.some((call) => call.startsWith('configure:')), false);
  assert.equal(harness.store.saves.length, 0);
});

test('status distinguishes missing, sign-in, unavailable, and unsupported Tailscale states', async () => {
  const missing = createHarness({ node: { state: 'missing' } });
  assert.deepEqual(await missing.coordinator.getStatus(), {
    state: 'tailscale-missing',
    installUrl: 'https://tailscale.com/download',
  });

  const signedOut = createHarness({
    node: {
      state: 'needs-login',
      authorizationUrl: 'https://login.tailscale.com/a/existing',
    },
  });
  assert.deepEqual(await signedOut.coordinator.getStatus(), {
    state: 'sign-in-required',
    authorizationUrl: 'https://login.tailscale.com/a/existing',
  });

  const stopped = createHarness({ node: { state: 'stopped' } });
  assert.deepEqual(await stopped.coordinator.getStatus(), {
    state: 'temporarily-unavailable',
    reason: 'stopped',
    message: 'Tailscale is stopped',
  });

  const awaitingMachineAuthorization = createHarness({
    node: { state: 'needs-machine-authorization' },
  });
  assert.deepEqual(await awaitingMachineAuthorization.coordinator.getStatus(), {
    state: 'temporarily-unavailable',
    reason: 'machine-authorization',
    message: 'This Tailscale device is awaiting administrator approval',
  });

  const unsupported = createHarness({
    node: { state: 'unsupported', backendState: 'FutureState' },
  });
  assert.deepEqual(await unsupported.coordinator.getStatus(), {
    state: 'retryable-failure',
    message: 'Unsupported Tailscale state: FutureState',
  });
  assert.equal(missing.calls.includes('inspect-serve'), false);
});

test('sign-in URL opens once and persisted setup resumes without reopening settings', async () => {
  const harness = createHarness({ node: { state: 'needs-login' } });
  assert.deepEqual(await harness.coordinator.setup({ loopbackPort: LOOPBACK_PORT }), {
    state: 'sign-in-required',
    authorizationUrl: 'https://login.tailscale.com/a/generated',
  });
  assert.deepEqual(harness.opened, ['https://login.tailscale.com/a/generated']);
  assert.equal(harness.store.state && 'phase' in harness.store.state, true);

  harness.setNode({ state: 'running', dnsName: DNS_NAME, httpsReady: true });
  assert.deepEqual(await harness.coordinator.getStatus(), {
    state: 'ready',
    origin: `https://${DNS_NAME}`,
  });
  assert.deepEqual(harness.opened, ['https://login.tailscale.com/a/generated']);
});

test('setup exposes configuring and verifies fresh Serve, node, and HTTPS health before ready', async () => {
  let releaseConfigure!: () => void;
  const configureGate = new Promise<void>((resolve) => { releaseConfigure = resolve; });
  const harness = createHarness({ configureGate });

  const setup = harness.coordinator.setup({ loopbackPort: LOOPBACK_PORT });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(await harness.coordinator.getStatus(), { state: 'configuring' });
  releaseConfigure();

  assert.deepEqual(await setup, { state: 'ready', origin: `https://${DNS_NAME}` });
  assert.deepEqual(harness.calls, [
    'inspect-node',
    'inspect-serve',
    'configure:443',
    'inspect-node',
    'inspect-serve',
    `health:https://${DNS_NAME}`,
  ]);
});

test('mobile connection becomes configured only after setup persists verified ownership', async () => {
  let releaseConfigure!: () => void;
  const configureGate = new Promise<void>((resolve) => { releaseConfigure = resolve; });
  const harness = createHarness({ configureGate });

  const setup = harness.coordinator.setup({ loopbackPort: LOOPBACK_PORT });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.coordinator.hasConfiguredConnection(), false);

  releaseConfigure();
  assert.deepEqual(await setup, { state: 'ready', origin: `https://${DNS_NAME}` });
  assert.equal(harness.coordinator.hasConfiguredConnection(), true);
});

test('HTTPS consent opens externally and resumes on the retained port', async () => {
  const consentUrl = 'https://login.tailscale.com/admin/feature/serve?node=example';
  const occupied443: TailscaleServeStatus = {
    endpoints: [{
      dnsName: DNS_NAME,
      port: 443,
      mountPath: '/',
      proxyTarget: 'http://127.0.0.1:9999',
      scope: 'background',
    }],
    occupiedPorts: [443],
    resources: [
      { key: 'background:tcp:443', value: '{"HTTPS":true}' },
      {
        key: `background:web:${DNS_NAME}:443:/`,
        value: '{"Proxy":"http://127.0.0.1:9999"}',
      },
    ],
  };
  const harness = createHarness({
    node: { state: 'running', dnsName: DNS_NAME, httpsReady: false },
    serve: occupied443,
    configureResult: { state: 'authorization-required', authorizationUrl: consentUrl },
  });

  assert.deepEqual(await harness.coordinator.setup({ loopbackPort: LOOPBACK_PORT }), {
    state: 'authorization-required',
    authorizationUrl: consentUrl,
  });
  assert.deepEqual(harness.opened, [consentUrl]);
  assert.equal(
    harness.store.state && 'phase' in harness.store.state
      ? harness.store.state.selectedServePort
      : null,
    MOBILE_ACCESS_HTTPS_PORT_CANDIDATES[0],
  );

  harness.setServe(emptyServe());
  harness.setNode({ state: 'running', dnsName: DNS_NAME, httpsReady: true });
  harness.setConfigureResult({ state: 'configured' });
  assert.deepEqual(await harness.coordinator.getStatus(), {
    state: 'ready',
    origin: `https://${DNS_NAME}:${MOBILE_ACCESS_HTTPS_PORT_CANDIDATES[0]}`,
  });
  assert.deepEqual(harness.opened, [consentUrl]);
});

test('443 conflict selects the first free candidate and preserves unrelated Serve and Funnel state', async () => {
  const [occupiedCandidate, expectedPort] = MOBILE_ACCESS_HTTPS_PORT_CANDIDATES;
  const unrelatedResources = [
    { key: 'background:allow-funnel:desktop.tailnet.ts.net:8080', value: 'true' },
    { key: `background:tcp:${occupiedCandidate}`, value: '{"HTTP":true}' },
    { key: 'background:tcp:443', value: '{"HTTPS":true}' },
    { key: 'background:tcp:8080', value: '{"HTTP":true}' },
    { key: `background:web:${DNS_NAME}:443:/`, value: '{"Text":"owned elsewhere"}' },
    { key: `background:web:${DNS_NAME}:8080:/api`, value: '{"Proxy":"http://127.0.0.1:8080"}' },
  ].sort((left, right) => left.key.localeCompare(right.key));
  const harness = createHarness({
    serve: {
      endpoints: [{
        dnsName: DNS_NAME,
        port: 8080,
        mountPath: '/api',
        proxyTarget: 'http://127.0.0.1:8080',
        scope: 'background',
      }],
      occupiedPorts: [443, 8080, occupiedCandidate],
      resources: unrelatedResources,
    },
  });

  assert.deepEqual(await harness.coordinator.setup({ loopbackPort: LOOPBACK_PORT }), {
    state: 'ready',
    origin: `https://${DNS_NAME}:${expectedPort}`,
  });
  assert.equal(harness.calls.includes(`configure:${expectedPort}`), true);
  const after = harness.serve().resources.filter((resource) => (
    resource.key !== `background:tcp:${expectedPort}`
    && resource.key !== `background:web:${DNS_NAME}:${expectedPort}:/`
  ));
  assert.deepEqual(after, unrelatedResources);
});

test('foreign TCP ownership on 443 forces the first high-port fallback', async () => {
  const harness = createHarness({
    serve: {
      endpoints: [],
      occupiedPorts: [443],
      resources: [{
        key: 'background:tcp:443',
        value: '{"TCPForward":"127.0.0.1:9000"}',
      }],
    },
  });

  assert.deepEqual(await harness.coordinator.setup({ loopbackPort: LOOPBACK_PORT }), {
    state: 'ready',
    origin: `https://${DNS_NAME}:${MOBILE_ACCESS_HTTPS_PORT_CANDIDATES[0]}`,
  });
  assert.equal(harness.calls.includes('configure:443'), false);
  assert.equal(harness.calls.includes(`configure:${MOBILE_ACCESS_HTTPS_PORT_CANDIDATES[0]}`), true);
});

test('a retained high port is revalidated before setup resumes', async () => {
  const [retainedPort] = MOBILE_ACCESS_HTTPS_PORT_CANDIDATES;
  const harness = createHarness({
    serve: {
      endpoints: [],
      occupiedPorts: [retainedPort],
      resources: [{
        key: `background:tcp:${retainedPort}`,
        value: '{"TCPForward":"127.0.0.1:9000"}',
      }],
    },
  });
  harness.store.state = {
    schemaVersion: 1,
    owner: MOBILE_ACCESS_OWNER,
    phase: 'setup',
    loopbackPort: LOOPBACK_PORT,
    selectedServePort: retainedPort,
    nodeDnsName: DNS_NAME,
  };

  assert.deepEqual(await harness.coordinator.getStatus(), {
    state: 'ownership-conflict',
    message: `Tailscale HTTPS port ${retainedPort} is no longer safe to configure`,
  });
  assert.equal(harness.calls.some((call) => call.startsWith('configure:')), false);
});

test('setup reports ownership conflict when every deterministic candidate is occupied', async () => {
  const resources = [
    { key: 'background:tcp:443', value: '{"HTTPS":true}' },
    { key: `background:web:${DNS_NAME}:443:/`, value: '{"Text":"foreign"}' },
    ...MOBILE_ACCESS_HTTPS_PORT_CANDIDATES.map((port) => ({
      key: `background:tcp:${port}`,
      value: '{"HTTP":true}',
    })),
  ].sort((left, right) => left.key.localeCompare(right.key));
  const harness = createHarness({
    serve: {
      endpoints: [],
      occupiedPorts: [443, ...MOBILE_ACCESS_HTTPS_PORT_CANDIDATES],
      resources,
    },
  });

  assert.deepEqual(await harness.coordinator.setup({ loopbackPort: LOOPBACK_PORT }), {
    state: 'ownership-conflict',
    message: 'No safe Tailscale HTTPS port is available',
  });
  assert.equal(harness.calls.some((call) => call.startsWith('configure:')), false);
});

test('unsupported Serve inspection fails closed without mutation', async () => {
  let configureCount = 0;
  const coordinator = new MobileAccessCoordinator({
    adapter: {
      async inspectNode() { return { state: 'running', dnsName: DNS_NAME, httpsReady: true }; },
      async requestSignIn() { return null; },
      async inspectServe() { throw new Error('unsupported Serve field: FutureConfig'); },
      async configureServe() { configureCount += 1; return { state: 'configured' }; },
    },
    stateStore: new MemoryStateStore(),
    async checkHealth() {},
    async openExternal() {},
  });

  assert.deepEqual(await coordinator.setup({ loopbackPort: LOOPBACK_PORT }), {
    state: 'retryable-failure',
    message: 'unsupported Serve field: FutureConfig',
  });
  assert.equal(configureCount, 0);
});

test('a command timeout becomes retryable and resumes without completing partial setup', async () => {
  const harness = createHarness({
    configureError: new Error('Tailscale command timed out after 15000ms'),
  });

  assert.deepEqual(await harness.coordinator.setup({ loopbackPort: LOOPBACK_PORT }), {
    state: 'retryable-failure',
    message: 'Tailscale command timed out after 15000ms',
  });
  assert.equal(harness.store.state && 'phase' in harness.store.state, true);

  harness.setConfigureError(null);
  assert.deepEqual(await harness.coordinator.getStatus(), {
    state: 'ready',
    origin: `https://${DNS_NAME}`,
  });
  assert.equal(harness.store.state && !('phase' in harness.store.state), true);
});

test('Windows persistence applies current-user ACLs and retains a selected high port', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'tessera-mobile-access-acl-'));
  const statePath = path.join(tempDir, 'machine', 'mobile-access.json');
  const protectedPaths: Array<{ targetPath: string; directory: boolean }> = [];
  const store = new FileMobileAccessStateStore(statePath, {
    platform: 'win32',
    async restrictWindowsPath(targetPath, directory) {
      protectedPaths.push({ targetPath, directory });
    },
  });
  const state: MobileAccessPersistedState = {
    schemaVersion: 1,
    owner: MOBILE_ACCESS_OWNER,
    phase: 'setup',
    loopbackPort: LOOPBACK_PORT,
    selectedServePort: MOBILE_ACCESS_HTTPS_PORT_CANDIDATES[0],
    nodeDnsName: DNS_NAME,
  };

  try {
    await store.save(state);
    assert.deepEqual(JSON.parse(await readFile(statePath, 'utf8')), state);
    assert.equal(protectedPaths[0]?.targetPath, path.dirname(statePath));
    assert.equal(protectedPaths[0]?.directory, true);
    assert.match(protectedPaths[1]?.targetPath ?? '', /\.mobile-access\..+\.tmp$/);
    assert.equal(protectedPaths[2]?.targetPath, statePath);
    assert.equal((await stat(statePath)).isFile(), true);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
