import assert from 'node:assert/strict';
import test from 'node:test';
import {
  selectTerminalGoalIndicator,
  selectVisibleTerminalGoal,
  useTerminalGoalStore,
} from '@/stores/terminal-goal-store';
import { resolveItemStatus } from '@/components/chat/work-item-primitives';
import {
  dismissTerminalGoalInHistory,
  latestEndedTerminalGoal,
  type TerminalGoalHistoryEntry,
  type TerminalGoalSnapshot,
} from '@/types/terminal-goal';

const achieved: TerminalGoalHistoryEntry = {
  provider: 'codex', objective: 'ship it', ending: 'complete', setAt: 1_000, endedAt: 5_000, tokensUsed: 42,
};

function reset() {
  useTerminalGoalStore.setState({ bySessionId: {}, dismissedSetAt: {}, historyBySessionId: {}, endedBySessionId: {} });
}

const state = () => useTerminalGoalStore.getState();

test('a finished goal keeps marking the session after the tracker lets go of it', () => {
  reset();
  state().setHistory('s1', [achieved]);
  const visible = selectVisibleTerminalGoal('s1')(state());
  assert.equal(visible?.status, 'complete');
  assert.equal(visible?.objective, 'ship it');
  assert.equal(visible, selectVisibleTerminalGoal('s1')(state()), 'stable object for the selector');
  assert.equal(selectTerminalGoalIndicator('s1')(state()), 'achieved');

  // The CLI exits: the tracker's goal is cleared, the persisted end remains.
  state().clearSession('s1');
  assert.equal(selectTerminalGoalIndicator('s1')(state()), 'achieved');
});

test('a live goal outranks the finished one; cleared or replaced ends leave no mark', () => {
  reset();
  state().setEndedSnapshot({ s1: achieved });
  const live: TerminalGoalSnapshot = { provider: 'codex', objective: 'next', status: 'active', setAt: 9_000, updatedAt: 9_000 };
  state().applyGoal('s1', live);
  assert.equal(selectVisibleTerminalGoal('s1')(state()), live);
  assert.equal(selectTerminalGoalIndicator('s1')(state()), 'active');

  assert.equal(latestEndedTerminalGoal([{ ...achieved, ending: 'cleared' }]), null);
  assert.equal(latestEndedTerminalGoal([{ ...achieved, ending: 'replaced' }, achieved]), null);
  assert.equal(latestEndedTerminalGoal([{ ...achieved, ending: 'failed' }])?.ending, 'failed');
});

test('closing the banner in another window drops the mark here too', () => {
  reset();
  // The tracker still holds the achieved goal it just saw.
  state().applyGoal('s1', { provider: 'codex', objective: 'ship it', status: 'complete', setAt: 1_000, updatedAt: 5_000 });
  state().setHistory('s1', [achieved]);
  assert.equal(selectTerminalGoalIndicator('s1')(state()), 'achieved');

  const dismissed = dismissTerminalGoalInHistory([achieved], 'codex', 1_000, 6_000);
  assert.equal(dismissed?.[0]?.dismissedAt, 6_000);
  assert.equal(dismissTerminalGoalInHistory(dismissed!, 'codex', 1_000, 7_000), null, 'already closed');
  state().setHistory('s1', dismissed!);
  assert.equal(selectVisibleTerminalGoal('s1')(state()), null);
  assert.equal(selectTerminalGoalIndicator('s1')(state()), null);
});

test('status dot: a finished goal colors only the unread dot', () => {
  const base = { hasUnread: false, isAwaitingUser: false, showsProcessing: false };
  assert.equal(resolveItemStatus({ ...base, goal: 'achieved', hasUnread: true }), 'goal-ended-unread');
  assert.equal(resolveItemStatus({ ...base, goal: 'failed', hasUnread: true }), 'goal-ended-unread');
  assert.equal(resolveItemStatus({ ...base, goal: 'achieved' }), 'running', 'read: the plain dot');
  assert.equal(resolveItemStatus({ ...base, goal: 'paused' }), 'goal');
  assert.equal(resolveItemStatus({ ...base, goal: null, hasUnread: true }), 'unread');
  assert.equal(resolveItemStatus({ ...base, goal: 'achieved', showsProcessing: true }), 'processing',
    'a new plain turn spins like any other');
  assert.equal(resolveItemStatus({ ...base, goal: 'active', showsProcessing: true }), 'goal-processing');
  assert.equal(resolveItemStatus({ ...base, goal: 'achieved', isAwaitingUser: true }), 'awaiting-user');
});
