import assert from 'node:assert/strict';
import test from 'node:test';
import { filterEligibleSessionPrRows } from '../src/lib/github/session-pr-sync';

const rows = [
  { id: 'active', work_dir: '/repo/active' },
  { id: 'historical', work_dir: '/repo/historical' },
];

test('bare-session PR polling keeps only live runtime sessions', () => {
  assert.deepEqual(
    filterEligibleSessionPrRows(rows, new Set(['active'])),
    [rows[0]],
  );
  assert.deepEqual(filterEligibleSessionPrRows(rows, new Set()), []);
});

test('explicit full PR reconciliation remains available without a filter', () => {
  assert.equal(filterEligibleSessionPrRows(rows), rows);
});
