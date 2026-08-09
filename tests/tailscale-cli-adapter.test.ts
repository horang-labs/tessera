import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildTailscaleServeArguments,
  parseTailscaleNodeStatus,
  parseTailscaleServeEndpoint,
} from '../electron/tailscale-cli-adapter';

test('the adapter derives HTTPS readiness and the owned Serve root from CLI JSON', () => {
  assert.deepEqual(parseTailscaleNodeStatus(JSON.stringify({
    BackendState: 'Running',
    Self: { DNSName: 'desktop.tailnet.ts.net.' },
    CertDomains: ['desktop.tailnet.ts.net'],
  })), {
    connected: true,
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
