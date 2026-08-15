import assert from 'node:assert/strict';
import test from 'node:test';
import type { IncomingMessage } from 'node:http';
import {
  attachRemoteAddressHeader,
  TESSERA_REMOTE_ADDRESS_HEADER,
} from '../src/lib/http/remote-address-header';

test('overwrites a client-supplied address with the raw socket address', () => {
  const request = {
    headers: { [TESSERA_REMOTE_ADDRESS_HEADER]: 'spoofed-address' },
    socket: { remoteAddress: '127.0.0.1' },
  } as IncomingMessage;

  attachRemoteAddressHeader(request);

  assert.equal(request.headers[TESSERA_REMOTE_ADDRESS_HEADER], '127.0.0.1');
});
