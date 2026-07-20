import assert from 'node:assert/strict';
import test from 'node:test';
import { TerminalResizeOutputTransaction } from '@/lib/terminal/terminal-resize-output-transaction';

test('resize output transaction removes split ED3 but preserves the rest of the redraw', () => {
  const output: string[] = [];
  const transaction = new TerminalResizeOutputTransaction({
    emit: (data) => output.push(data),
  });

  transaction.begin();
  transaction.accept('before\x1b[');
  transaction.accept('3J\x1b[2J\x1b[Hafter');
  transaction.dispose();

  assert.equal(output.join(''), 'before\x1b[2J\x1b[Hafter');
});

test('a repeated resize keeps an incomplete ED3 inside the same transaction', () => {
  const output: string[] = [];
  const transaction = new TerminalResizeOutputTransaction({
    emit: (data) => output.push(data),
  });

  transaction.begin();
  transaction.accept('before\x1b[');
  transaction.begin();
  transaction.accept('3Jafter');
  transaction.dispose();

  assert.equal(output.join(''), 'beforeafter');
});

test('overlapping resizes each consume their own redraw clear', () => {
  const output: string[] = [];
  const transaction = new TerminalResizeOutputTransaction({
    emit: (data) => output.push(data),
  });

  transaction.begin();
  transaction.begin();
  transaction.accept('\x1b[3Jfirst');
  transaction.accept('\x1b[3Jsecond');
  transaction.dispose();

  assert.equal(output.join(''), 'firstsecond');
});

test('a clear after the resize-owned ED3 is forwarded even in the same chunk', () => {
  const output: string[] = [];
  const transaction = new TerminalResizeOutputTransaction({
    emit: (data) => output.push(data),
  });

  transaction.begin();
  transaction.accept(`\x1b[3Jresize-redraw\x1b[3J`);
  transaction.dispose();

  assert.equal(output.join(''), `resize-redraw\x1b[3J`);
});

test('resize transaction waits for a delayed redraw instead of expiring on a timer', async () => {
  const output: string[] = [];
  const transaction = new TerminalResizeOutputTransaction({
    emit: (data) => output.push(data),
  });

  transaction.begin();
  transaction.accept('redraw-not-started-yet');
  await new Promise((resolve) => setTimeout(resolve, 1_050));
  transaction.accept('\x1b[3Jdelayed-redraw');
  transaction.dispose();

  assert.equal(output.join(''), 'redraw-not-started-yetdelayed-redraw');
});

test('ED3 outside a resize transaction is forwarded unchanged', () => {
  const output: string[] = [];
  const transaction = new TerminalResizeOutputTransaction({
    emit: (data) => output.push(data),
  });

  transaction.accept('\x1b[3J');
  transaction.dispose();

  assert.equal(output.join(''), '\x1b[3J');
});

test('settling waits for an incomplete control sequence before releasing the transaction', () => {
  const output: string[] = [];
  const transaction = new TerminalResizeOutputTransaction({
    emit: (data) => output.push(data),
  });

  transaction.begin();
  transaction.accept('text\x1b[');
  transaction.settle();
  assert.equal(output.join(''), 'text');

  transaction.accept('3Jafter');
  transaction.dispose();

  assert.equal(output.join(''), 'textafter');
});
