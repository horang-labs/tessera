import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeExternalHttpUrl } from '../src/lib/external-http-url';

test('normalizes HTTP links, including loopback development servers', () => {
  assert.deepEqual(
    [
      normalizeExternalHttpUrl('http://127.0.0.1:3100'),
      normalizeExternalHttpUrl('https://example.com/docs?q=1'),
    ],
    [
      'http://127.0.0.1:3100/',
      'https://example.com/docs?q=1',
    ],
  );
});

test('rejects non-web protocols and malformed external URLs', () => {
  assert.deepEqual(
    [
      normalizeExternalHttpUrl('javascript:alert(1)'),
      normalizeExternalHttpUrl('file:///tmp/report.html'),
      normalizeExternalHttpUrl('not a url'),
      normalizeExternalHttpUrl(undefined),
    ],
    [null, null, null, null],
  );
});
