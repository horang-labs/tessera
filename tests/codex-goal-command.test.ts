import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildCodexGoalEditUpdate,
  countCodexGoalObjectiveCharacters,
  parseCodexGoalCommand,
  parseCodexGoalEditObjective,
} from '../src/lib/chat/codex-goal-command';
import type { SessionGoal, SessionGoalStatus } from '../src/types/session-goal';

function goal(status: SessionGoalStatus): SessionGoal {
  return {
    threadId: 'thread-1',
    objective: 'original',
    status,
    tokenBudget: 12_000,
    tokensUsed: 100,
    timeUsedSeconds: 20,
    createdAt: 1,
    updatedAt: 2,
  };
}

test('/goal edit is a control command outside edit mode', () => {
  assert.deepEqual(parseCodexGoalCommand('/goal edit'), { kind: 'edit' });
});

test('goal edit treats control keywords as objective text', () => {
  assert.equal(parseCodexGoalEditObjective('/goal clear'), 'clear');
  assert.equal(parseCodexGoalEditObjective('/goal pause'), 'pause');
  assert.equal(parseCodexGoalEditObjective('/goal'), '');
});

test('goal edit preserves resumable statuses and token budget', () => {
  for (const status of ['active', 'paused', 'blocked', 'usageLimited'] as const) {
    assert.deepEqual(buildCodexGoalEditUpdate(goal(status), 'updated'), {
      objective: 'updated',
      tokenBudget: 12_000,
      status,
    });
  }
});

test('goal edit reactivates terminal limited statuses', () => {
  for (const status of ['budgetLimited', 'complete'] as const) {
    assert.equal(buildCodexGoalEditUpdate(goal(status), 'updated').status, 'active');
  }
});

test('goal objective length follows Rust Unicode scalar counting', () => {
  assert.equal(countCodexGoalObjectiveCharacters('a😀한'), 3);
});
