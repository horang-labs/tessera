import assert from 'node:assert/strict';
import test from 'node:test';

import { getTerminalFontSize } from '@/lib/terminal/terminal-font-size';

test('terminal font size compensates for the monospace font appearing larger than the UI font', () => {
  assert.equal(getTerminalFontSize(0.8125), 11.375);
  assert.equal(getTerminalFontSize(1), 14);
  assert.equal(getTerminalFontSize(1.1875), 16.625);
  assert.equal(getTerminalFontSize(1.375), 19.25);
});
