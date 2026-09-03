import assert from 'node:assert/strict';
import test from 'node:test';
import { TerminalCompositionRenderGate } from '../src/lib/terminal/terminal-composition-render-gate';

test('holds repaint suppression until xterm settles the composition transaction', () => {
  const target = new EventTarget();
  let settled = 0;
  const gate = new TerminalCompositionRenderGate(target, () => settled += 1);

  target.dispatchEvent(new Event('compositionstart'));
  assert.equal(gate.isActive(), true);

  target.dispatchEvent(new Event('compositionend'));
  assert.equal(gate.isActive(), true);
  assert.equal(settled, 0);

  target.dispatchEvent(new Event('xterm-composition-transaction-settled'));
  assert.equal(gate.isActive(), false);
  assert.equal(settled, 1);
  gate.dispose();
});

test('releases an abandoned composition on focusout', () => {
  const target = new EventTarget();
  let settled = 0;
  const gate = new TerminalCompositionRenderGate(target, () => settled += 1);
  target.dispatchEvent(new Event('xterm-composition-session-start'));
  target.dispatchEvent(new Event('focusout'));

  assert.equal(gate.isActive(), false);
  assert.equal(settled, 1);
  gate.dispose();
});
