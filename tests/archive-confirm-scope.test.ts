import assert from 'node:assert/strict';
import test from 'node:test';
import { isArchiveConfirmationArmed } from '@/hooks/use-archive-confirm';

test('archive confirmation is scoped to the Task that armed it', () => {
  assert.equal(isArchiveConfirmationArmed('task-a', 'task-a'), true);
  assert.equal(isArchiveConfirmationArmed('task-a', 'task-b'), false);
  assert.equal(isArchiveConfirmationArmed(null, 'task-a'), false);
});

test('unscoped archive controls retain their existing shared scope', () => {
  assert.equal(isArchiveConfirmationArmed('', undefined), true);
});
