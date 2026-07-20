import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createTerminalStartupColorQueryBridge,
  formatTerminalOscColorReply,
} from '@/lib/terminal/terminal-startup-color-query';

const COLORS = {
  foreground: '#25282b',
  background: '#fafaf9',
};

test('terminal startup color bridge answers and consumes OSC foreground/background queries', () => {
  const replies: string[] = [];
  const bridge = createTerminalStartupColorQueryBridge(COLORS, (reply) => replies.push(reply));

  const output = bridge.consume('\x1b]10;?\x1b\\\x1b]11;?\x07ready');

  assert.equal(output, 'ready');
  assert.deepEqual(replies, [
    '\x1b]10;rgb:2525/2828/2b2b\x1b\\',
    '\x1b]11;rgb:fafa/fafa/f9f9\x1b\\',
  ]);
});

test('terminal startup color bridge handles a combined query split across PTY chunks', () => {
  const replies: string[] = [];
  const bridge = createTerminalStartupColorQueryBridge(COLORS, (reply) => replies.push(reply));

  assert.equal(bridge.consume('before\x1b]10;?;'), 'before');
  assert.equal(bridge.consume('?\x1b\\after'), 'after');
  assert.deepEqual(replies, [
    '\x1b]10;rgb:2525/2828/2b2b\x1b\\',
    '\x1b]11;rgb:fafa/fafa/f9f9\x1b\\',
  ]);
});

test('terminal startup color bridge preserves unrelated and malformed OSC output', () => {
  const replies: string[] = [];
  const bridge = createTerminalStartupColorQueryBridge(COLORS, (reply) => replies.push(reply));
  const data = '\x1b]0;title\x07\x1b]11;not-a-query\x1b\\ready';

  assert.equal(bridge.consume(data), data);
  assert.deepEqual(replies, []);
});

test('terminal OSC color replies reject values that could inject control sequences', () => {
  assert.equal(formatTerminalOscColorReply(11, '#101214'), '\x1b]11;rgb:1010/1212/1414\x1b\\');
  assert.equal(formatTerminalOscColorReply(11, 'red\x1b\\'), null);
});
