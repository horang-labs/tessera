import assert from 'node:assert/strict';
import test from 'node:test';
import { forceRepaintThroughRenderPause } from '@/lib/terminal/terminal-render-pause-release';

interface RefreshCall {
  start: number;
  end: number;
  sync: boolean | undefined;
}

function createTerminal(
  options: { paused: boolean; rows?: number; onRefresh?: () => void } = { paused: true },
): { terminal: unknown; calls: RefreshCall[]; service: Record<string, unknown> } {
  const calls: RefreshCall[] = [];
  const service = {
    _isPaused: options.paused,
    _needsFullRefresh: true,
    refreshRows(start: number, end: number, sync?: boolean) {
      calls.push({ start, end, sync });
      options.onRefresh?.();
    },
  };
  const terminal = { rows: options.rows ?? 24, _core: { _renderService: service } };
  return { terminal, calls, service: service as unknown as Record<string, unknown> };
}

test('paused renderer is driven synchronously across the full viewport', () => {
  const { terminal, calls } = createTerminal({ paused: true, rows: 24 });

  assert.equal(forceRepaintThroughRenderPause(terminal), true);
  assert.deepEqual(calls, [{ start: 0, end: 23, sync: true }]);
});

test('pause latches are cleared so the observer does not queue a second repaint', () => {
  const { terminal, service } = createTerminal({ paused: true });

  forceRepaintThroughRenderPause(terminal);

  assert.equal(service._isPaused, false);
  assert.equal(service._needsFullRefresh, false);
});

test('an unpaused renderer is left untouched so the caller falls back to refresh', () => {
  const { terminal, calls } = createTerminal({ paused: false });

  assert.equal(forceRepaintThroughRenderPause(terminal), false);
  assert.deepEqual(calls, []);
});

test('missing xterm internals degrade to a no-op instead of throwing', () => {
  assert.equal(forceRepaintThroughRenderPause(null), false);
  assert.equal(forceRepaintThroughRenderPause(undefined), false);
  assert.equal(forceRepaintThroughRenderPause({}), false);
  assert.equal(forceRepaintThroughRenderPause({ rows: 24, _core: {} }), false);
  // A renamed internal leaves refreshRows undefined — must not throw.
  assert.equal(
    forceRepaintThroughRenderPause({ rows: 24, _core: { _renderService: { _isPaused: true } } }),
    false,
  );
});

test('a terminal without usable rows is skipped', () => {
  const { terminal: zeroRows, calls: zeroCalls } = createTerminal({ paused: true, rows: 0 });
  assert.equal(forceRepaintThroughRenderPause(zeroRows), false);
  assert.deepEqual(zeroCalls, []);

  const { terminal: noRows } = createTerminal({ paused: true });
  (noRows as { rows?: number }).rows = undefined;
  assert.equal(forceRepaintThroughRenderPause(noRows), false);
});

test('a throwing render reports failure so the caller can still fall back', () => {
  const { terminal } = createTerminal({
    paused: true,
    onRefresh: () => {
      throw new Error('renderer disposed mid-frame');
    },
  });

  assert.equal(forceRepaintThroughRenderPause(terminal), false);
});
