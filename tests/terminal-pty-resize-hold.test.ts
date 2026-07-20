import assert from 'node:assert/strict';
import test from 'node:test';

import {
  TerminalPtyResizeHoldCoordinator,
  type TerminalPtyResizeRequest,
} from '../src/lib/terminal/terminal-pty-resize-hold';

test('a divider drag flushes only the final PTY size for each terminal surface', () => {
  let settleLayout: (() => void) | null = null;
  const coordinator = new TerminalPtyResizeHoldCoordinator((flush) => {
    settleLayout = flush;
    return () => { settleLayout = null; };
  });
  const sent: Array<{ surfaceId: string; request: TerminalPtyResizeRequest }> = [];
  const send = (surfaceId: string) => (request: TerminalPtyResizeRequest) => {
    sent.push({ surfaceId, request });
  };
  const drag = coordinator.begin();

  assert.equal(coordinator.queueIfHeld(
    'left',
    { cols: 90, rows: 30, claim: false },
    send('left'),
  ), true);
  assert.equal(coordinator.queueIfHeld(
    'right',
    { cols: 110, rows: 30, claim: false },
    send('right'),
  ), true);
  assert.equal(coordinator.queueIfHeld(
    'left',
    { cols: 115, rows: 30, claim: true },
    send('left'),
  ), true);
  assert.equal(coordinator.queueIfHeld(
    'left',
    { cols: 120, rows: 30, claim: false },
    send('left'),
  ), true);

  assert.deepEqual(sent, []);

  drag.flush();

  assert.deepEqual(sent, []);
  assert.equal(coordinator.queueIfHeld(
    'left',
    { cols: 125, rows: 30, claim: false },
    send('left'),
  ), true);
  assert.ok(settleLayout);
  settleLayout();

  assert.deepEqual(sent, [
    { surfaceId: 'left', request: { cols: 125, rows: 30, claim: true } },
    { surfaceId: 'right', request: { cols: 110, rows: 30, claim: false } },
  ]);
});

test('a cancelled divider drag discards its queued PTY sizes', () => {
  const coordinator = new TerminalPtyResizeHoldCoordinator();
  const sent: TerminalPtyResizeRequest[] = [];
  const drag = coordinator.begin();

  coordinator.queueIfHeld(
    'terminal',
    { cols: 80, rows: 24, claim: false },
    (request) => sent.push(request),
  );
  drag.cancel();
  drag.flush();

  assert.deepEqual(sent, []);
  assert.equal(coordinator.queueIfHeld(
    'terminal',
    { cols: 100, rows: 30, claim: false },
    (request) => sent.push(request),
  ), false);
});

test('rapid successive drags settle to one final PTY size', () => {
  let settleLayout: (() => void) | null = null;
  const coordinator = new TerminalPtyResizeHoldCoordinator((flush) => {
    settleLayout = flush;
    return () => { settleLayout = null; };
  });
  const sent: TerminalPtyResizeRequest[] = [];
  const send = (request: TerminalPtyResizeRequest) => sent.push(request);
  const firstDrag = coordinator.begin();

  coordinator.queueIfHeld('terminal', { cols: 100, rows: 30, claim: false }, send);
  firstDrag.flush();
  assert.deepEqual(sent, []);

  const secondDrag = coordinator.begin();
  assert.deepEqual(sent, []);

  coordinator.queueIfHeld('terminal', { cols: 105, rows: 30, claim: false }, send);
  coordinator.queueIfHeld('terminal', { cols: 90, rows: 30, claim: false }, send);
  secondDrag.flush();
  coordinator.queueIfHeld('terminal', { cols: 105, rows: 30, claim: false }, send);
  assert.ok(settleLayout);
  settleLayout();

  assert.deepEqual(sent, [{ cols: 105, rows: 30, claim: false }]);
});
