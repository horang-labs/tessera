import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createTerminalAppearanceController,
  formatTerminalOscColorReply,
  type TerminalAppearance,
} from '@/lib/terminal/terminal-appearance-controller';

const LIGHT: TerminalAppearance = {
  mode: 'light',
  foreground: '#25282b',
  background: '#fafaf9',
};

const DARK: TerminalAppearance = {
  mode: 'dark',
  foreground: '#e3e9ed',
  background: '#161616',
};

test('terminal appearance controller answers OSC colors for its current appearance for the full runtime', () => {
  const replies: string[] = [];
  const controller = createTerminalAppearanceController(LIGHT, (reply) => replies.push(reply));

  assert.equal(controller.consumeOutput('\x1b]10;?\x1b\\\x1b]11;?\x07ready'), 'ready');
  controller.updateAppearance(DARK);
  assert.equal(controller.consumeOutput('\x1b]11;?\x1b\\later'), 'later');

  assert.deepEqual(replies, [
    '\x1b]10;rgb:2525/2828/2b2b\x1b\\',
    '\x1b]11;rgb:fafa/fafa/f9f9\x1b\\',
    '\x1b]11;rgb:1616/1616/1616\x1b\\',
  ]);
});

test('terminal appearance controller answers a combined OSC query split across PTY chunks', () => {
  const replies: string[] = [];
  const controller = createTerminalAppearanceController(LIGHT, (reply) => replies.push(reply));

  assert.equal(controller.consumeOutput('before\x1b]10;?;'), 'before');
  assert.equal(controller.consumeOutput('?\x1b\\after'), 'after');
  assert.deepEqual(replies, [
    '\x1b]10;rgb:2525/2828/2b2b\x1b\\',
    '\x1b]11;rgb:fafa/fafa/f9f9\x1b\\',
  ]);
});

test('terminal appearance controller seeds and flips a DEC 2031 subscriber', () => {
  const replies: string[] = [];
  const controller = createTerminalAppearanceController(LIGHT, (reply) => replies.push(reply));

  assert.equal(controller.consumeOutput('a\x1b[?20'), 'a\x1b[?20');
  assert.equal(controller.consumeOutput('31hb'), '31hb');
  assert.equal(controller.isDynamicColorSchemeSubscribed(), true);
  controller.updateAppearance(DARK);

  assert.deepEqual(replies, [
    '\x1b[?997;2n',
    '\x1b[?997;1n',
  ]);
});

test('terminal appearance controller stops flips after DEC 2031 unsubscribe', () => {
  const replies: string[] = [];
  const controller = createTerminalAppearanceController(LIGHT, (reply) => replies.push(reply));

  controller.consumeOutput('\x1b[?2031h\x1b[?2031l');
  controller.updateAppearance(DARK);

  assert.equal(controller.isDynamicColorSchemeSubscribed(), false);
  assert.deepEqual(replies, ['\x1b[?997;2n']);
});

test('terminal appearance controller preserves unrelated and malformed OSC output', () => {
  const replies: string[] = [];
  const controller = createTerminalAppearanceController(LIGHT, (reply) => replies.push(reply));
  const data = '\x1b]0;title\x07\x1b]11;not-a-query\x1b\\ready';

  assert.equal(controller.consumeOutput(data), data);
  assert.deepEqual(replies, []);
});

test('terminal OSC color replies reject values that could inject control sequences', () => {
  assert.equal(formatTerminalOscColorReply(11, '#101214'), '\x1b]11;rgb:1010/1212/1414\x1b\\');
  assert.equal(formatTerminalOscColorReply(11, 'red\x1b\\'), null);
});
