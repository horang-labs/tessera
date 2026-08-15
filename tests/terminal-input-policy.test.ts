import assert from 'node:assert/strict';
import test from 'node:test';
import { sanitizeXtermGeneratedData } from '../src/lib/terminal/terminal-input-policy';

test('preserves valid SGR mouse reports and surrounding terminal data', () => {
  const data = `before\x1b[<64;12;34M\x1b[<0;1;2mafter`;
  assert.deepEqual(sanitizeXtermGeneratedData(data), {
    data,
    droppedMouseReports: 0,
  });
});

test('drops only malformed SGR mouse reports', () => {
  assert.deepEqual(
    sanitizeXtermGeneratedData(`a\x1b[<65;NaN;NaNM\x1b[<65;8;9Mb`),
    {
      data: `a\x1b[<65;8;9Mb`,
      droppedMouseReports: 1,
    },
  );
});

test('does not treat literal NaN, parser replies, or incomplete prefixes as mouse reports', () => {
  for (const data of [
    'NaN',
    '\x1b[12;34R',
    '\x1b[200~literal NaN\x1b[201~',
    '\x1b[<65;12',
  ]) {
    assert.deepEqual(sanitizeXtermGeneratedData(data), {
      data,
      droppedMouseReports: 0,
    });
  }
});

test('rejects non-decimal and out-of-contract SGR fields', () => {
  const data = '\x1b[<65;-1;2M\x1b[<65;10000;2M\x1b[<x;2;3M';
  assert.deepEqual(sanitizeXtermGeneratedData(data), {
    data: '',
    droppedMouseReports: 3,
  });
});
