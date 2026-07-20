import assert from 'node:assert/strict';
import test from 'node:test';
import { getTerminalScrollbarGeometry } from '../src/lib/terminal/terminal-scrollbar-geometry';

test('terminal scrollbar fills the track when there is no scrollback', () => {
  assert.deepEqual(
    getTerminalScrollbarGeometry({ baseY: 0, viewportY: 0, rows: 30 }, 300),
    { height: 300, top: 0 },
  );
});

test('terminal scrollbar keeps a usable minimum thumb and tracks the viewport', () => {
  const middle = getTerminalScrollbarGeometry(
    { baseY: 970, viewportY: 485, rows: 30 },
    300,
  );
  assert.deepEqual(middle, { height: 28, top: 136 });

  const bottom = getTerminalScrollbarGeometry(
    { baseY: 970, viewportY: 970, rows: 30 },
    300,
  );
  assert.deepEqual(bottom, { height: 28, top: 272 });
});

test('terminal scrollbar clamps stale viewport coordinates after reflow', () => {
  assert.deepEqual(
    getTerminalScrollbarGeometry({ baseY: 20, viewportY: 200, rows: 20 }, 100),
    { height: 50, top: 50 },
  );
});
