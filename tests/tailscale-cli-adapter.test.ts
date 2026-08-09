import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildTailscaleServeArguments,
  createCommandRunner,
  parseTailscaleNodeStatus,
  parseTailscaleServeStatus,
  parseTailscaleServeEndpoint,
  TailscaleCliAdapter,
} from '../electron/tailscale-cli-adapter';

test('the adapter derives HTTPS readiness and the owned Serve root from CLI JSON', () => {
  assert.deepEqual(parseTailscaleNodeStatus(JSON.stringify({
    BackendState: 'Running',
    Self: { DNSName: 'desktop.tailnet.ts.net.' },
    CertDomains: ['desktop.tailnet.ts.net'],
  })), {
    state: 'running',
    dnsName: 'desktop.tailnet.ts.net',
    httpsReady: true,
  });

  assert.deepEqual(parseTailscaleServeEndpoint(JSON.stringify({
    TCP: { 443: { HTTPS: true } },
    Web: {
      'desktop.tailnet.ts.net:443': {
        Handlers: { '/': { Proxy: 'http://127.0.0.1:32123' } },
      },
    },
  }), 'desktop.tailnet.ts.net'), {
    dnsName: 'desktop.tailnet.ts.net',
    port: 443,
    mountPath: '/',
    proxyTarget: 'http://127.0.0.1:32123',
    scope: 'background',
  });

  assert.deepEqual(
    buildTailscaleServeArguments('http://127.0.0.1:32123'),
    [
      'serve',
      '--bg',
      '--yes',
      '--https=443',
      '--set-path=/',
      'http://127.0.0.1:32123',
    ],
  );
});

test('the adapter uses only scoped Serve commands and surfaces HTTPS consent', async () => {
  const calls: string[][] = [];
  const adapter = new TailscaleCliAdapter(async (arguments_) => {
    calls.push(arguments_);
    return {
      stdout: 'Enable HTTPS:\nhttps://login.tailscale.com/admin/feature/serve?node=example\n',
      stderr: '',
      authorizationUrl: 'https://login.tailscale.com/admin/feature/serve?node=example',
    };
  });

  assert.deepEqual(await adapter.configureServe({
    dnsName: 'desktop.tailnet.ts.net',
    port: 10_443,
    mountPath: '/',
    proxyTarget: 'http://127.0.0.1:32123',
    scope: 'background',
  }), {
    state: 'authorization-required',
    authorizationUrl: 'https://login.tailscale.com/admin/feature/serve?node=example',
  });
  assert.deepEqual(calls, [[
    'serve',
    '--bg',
    '--yes',
    '--https=10443',
    '--set-path=/',
    'http://127.0.0.1:32123',
  ]]);
  assert.equal(calls.flat().includes('funnel'), false);
  assert.equal(calls.flat().includes('reset'), false);
});

test('command execution terminates authorization waits and enforces a bounded timeout', async () => {
  const runner = createCommandRunner(process.execPath, 250);
  const authorization = await runner([
    '-e',
    "console.log('https://login.tailscale.com/a/example'); setInterval(() => {}, 1000)",
  ], { stopOnAuthorizationUrl: true });
  assert.equal(authorization.authorizationUrl, 'https://login.tailscale.com/a/example');

  await assert.rejects(
    runner(['-e', 'setInterval(() => {}, 1000)']),
    /timed out after 250ms/,
  );
});

test('unknown Serve configuration shapes fail closed', () => {
  assert.throws(() => parseTailscaleServeStatus(JSON.stringify({
    FutureConfig: { enabled: true },
  }), 'desktop.tailnet.ts.net'), /unsupported Serve field: FutureConfig/);
});

test('the adapter classifies sign-in and preserves unrelated Serve resources', () => {
  assert.deepEqual(parseTailscaleNodeStatus(JSON.stringify({
    BackendState: 'NeedsLogin',
    AuthURL: 'https://login.tailscale.com/a/example',
  })), {
    state: 'needs-login',
    authorizationUrl: 'https://login.tailscale.com/a/example',
  });

  assert.deepEqual(parseTailscaleServeStatus(JSON.stringify({
    TCP: {
      443: { HTTPS: true },
      8080: { HTTP: true },
    },
    Web: {
      'desktop.tailnet.ts.net:443': {
        Handlers: {
          '/other': { Text: 'leave me alone' },
        },
      },
      'desktop.tailnet.ts.net:8080': {
        Handlers: {
          '/': { Proxy: 'http://127.0.0.1:8080' },
        },
      },
    },
    AllowFunnel: {
      'desktop.tailnet.ts.net:8080': true,
    },
  }), 'desktop.tailnet.ts.net'), {
    endpoints: [{
      dnsName: 'desktop.tailnet.ts.net',
      port: 8080,
      mountPath: '/',
      proxyTarget: 'http://127.0.0.1:8080',
      scope: 'background',
    }],
    occupiedPorts: [443, 8080],
    resources: [
      { key: 'background:allow-funnel:desktop.tailnet.ts.net:8080', value: 'true' },
      { key: 'background:tcp:443', value: '{"HTTPS":true}' },
      { key: 'background:tcp:8080', value: '{"HTTP":true}' },
      {
        key: 'background:web:desktop.tailnet.ts.net:443:/other',
        value: '{"Text":"leave me alone"}',
      },
      {
        key: 'background:web:desktop.tailnet.ts.net:8080:/',
        value: '{"Proxy":"http://127.0.0.1:8080"}',
      },
    ],
  });
});
