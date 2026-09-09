import assert from 'node:assert/strict';
import test from 'node:test';
import { parseOsc52Payload } from '../src/lib/terminal/terminal-osc52';

const base64 = (text: string): string => Buffer.from(text, 'utf8').toString('base64');

test('OSC 52 decodes a system-clipboard write payload', () => {
  const text = 'hello opencode';
  assert.equal(parseOsc52Payload(`c;${base64(text)}`), text);
});

test('OSC 52 decodes non-ASCII text as UTF-8', () => {
  const text = '한글 복사 테스트';
  assert.equal(parseOsc52Payload(`c;${base64(text)}`), text);
});

test('OSC 52 read requests are never answered', () => {
  assert.equal(parseOsc52Payload('c;?'), null);
  assert.equal(parseOsc52Payload('c;'), null);
});

test('OSC 52 ignores non-system selections', () => {
  assert.equal(parseOsc52Payload(`p;${base64('primary')}`), null);
  assert.equal(parseOsc52Payload(`s;${base64('secondary')}`), null);
});

test('OSC 52 rejects malformed payloads', () => {
  assert.equal(parseOsc52Payload('no-separator'), null);
  assert.equal(parseOsc52Payload('c;!!!not-base64!!!'), null);
});
