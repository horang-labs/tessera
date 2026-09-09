import assert from 'node:assert/strict';
import test from 'node:test';
import { deriveTaskWorkflowStatusFromPr } from '@/lib/github/task-pr-workflow-policy';
import type { TaskPrStatus } from '@/types/task-pr-status';

function pr(
  state: TaskPrStatus['state'],
  relation: TaskPrStatus['relation'] = 'current',
): TaskPrStatus {
  return {
    number: 816,
    url: 'https://github.com/horang-labs/tessera/pull/816',
    state,
    relation,
    lastSynced: '2026-08-16T00:00:00.000Z',
  };
}

test('a current open PR makes Review authoritative', () => {
  assert.equal(deriveTaskWorkflowStatusFromPr(pr('open')), 'in_review');
});

test('a current merged PR makes Done authoritative', () => {
  assert.equal(deriveTaskWorkflowStatusFromPr(pr('merged')), 'done');
});

test('historical, closed, and absent PRs do not move workflow', () => {
  assert.equal(deriveTaskWorkflowStatusFromPr(pr('merged', 'historical')), undefined);
  assert.equal(deriveTaskWorkflowStatusFromPr(pr('closed')), undefined);
  assert.equal(deriveTaskWorkflowStatusFromPr(null), undefined);
});
