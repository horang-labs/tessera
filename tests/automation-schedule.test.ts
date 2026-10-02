import assert from 'node:assert/strict';
import test from 'node:test';
import { nextScheduledAt, dueOccurrence } from '../src/lib/automation/schedule';

test('fixed UTC intervals coalesce downtime into the latest slot and a future next due', () => {
  const trigger = { kind: 'interval', anchorAt: 60_000, everyMs: 60_000 } as const;
  assert.equal(nextScheduledAt(trigger, 120_000), 180_000);
  assert.deepEqual(dueOccurrence(trigger, 60_000, 245_000, 900_000), {
    occurrenceKey: 'interval:240000', dueAt: 240_000, deadlineAt: 900_000,
    coalescedCount: 3, nextDueAt: 300_000,
  });
  assert.equal(dueOccurrence(trigger, 300_000, 245_000, 900_000), null);
});
