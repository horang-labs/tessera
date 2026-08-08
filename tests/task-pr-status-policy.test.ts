import assert from 'node:assert/strict';
import test from 'node:test';
import { detectPrMismatch } from '@/components/chat/task-pr-badge';
import type { TaskPrStatus } from '@/types/task-pr-status';

function pr(
  state: TaskPrStatus['state'],
  relation: TaskPrStatus['relation'],
): TaskPrStatus {
  return {
    number: 236,
    url: 'https://github.com/horang-labs/tessera/pull/236',
    state,
    relation,
    lastSynced: '2026-08-09T00:00:00.000Z',
  };
}

test('historical PRs do not satisfy Review or Done workflow claims', () => {
  assert.equal(detectPrMismatch('in_review', pr('merged', 'historical')), 'review_missing');
  assert.equal(detectPrMismatch('done', pr('merged', 'historical')), 'done_missing');
  assert.equal(detectPrMismatch('done', pr('closed', 'historical')), 'done_missing');
});

test('current open and merged PRs retain workflow semantics', () => {
  assert.equal(detectPrMismatch('in_review', pr('open', 'current')), null);
  assert.equal(detectPrMismatch('done', pr('open', 'current')), 'done_open');
  assert.equal(detectPrMismatch('done', pr('merged', 'current')), null);
});
