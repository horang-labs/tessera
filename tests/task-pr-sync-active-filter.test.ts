import assert from 'node:assert/strict';
import test from 'node:test';
import { filterEligibleTaskPrRows } from '../src/lib/github/task-pr-sync';

const rows = [
  { id: 'active', projectId: 'one' },
  { id: 'historical', projectId: 'two' },
];

test('periodic task PR sync can be limited to active runtime owners', () => {
  assert.deepEqual(
    filterEligibleTaskPrRows(rows, new Set(['active'])),
    [rows[0]],
  );
  assert.deepEqual(filterEligibleTaskPrRows(rows, new Set()), []);
});

test('explicit reconciliation can still request every eligible task', () => {
  assert.equal(filterEligibleTaskPrRows(rows), rows);
});
