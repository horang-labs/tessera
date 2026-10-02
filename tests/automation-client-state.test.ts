import assert from 'node:assert/strict';
import test from 'node:test';
import { applySessionInputOwnership, getSessionInputOwnership, subscribeSessionInputOwnership } from '../src/lib/automation/client-state';
import type { InputOwnership } from '../src/lib/automation/contracts';

test('ownership starts unavailable and subscriptions observe only their Session', () => {
  const initial = getSessionInputOwnership('client-session');
  assert.equal(initial.mode, 'unavailable');
  assert.equal(initial.terminalId, null);
  assert.equal(getSessionInputOwnership('client-session'), initial);
  const seen: string[] = [];
  const unsubscribe = subscribeSessionInputOwnership('client-session', () => {
    seen.push(getSessionInputOwnership('client-session').mode);
  });
  const value: InputOwnership = {
    sessionId: 'client-session', terminalId: 'term-1', epoch: 'opaque-1',
    mode: 'armed', automationId: 'rule-1', runId: null, reason: null,
  };
  applySessionInputOwnership({ ...value, sessionId: 'another-session' });
  applySessionInputOwnership(value);
  applySessionInputOwnership({ ...value, mode: 'draining', epoch: 'opaque-2' });
  applySessionInputOwnership({ ...value, mode: 'human', epoch: 'opaque-3', automationId: null });
  assert.deepEqual(seen, ['armed', 'draining', 'human']);
  unsubscribe();
  applySessionInputOwnership({ ...value, mode: 'unavailable', epoch: '', terminalId: null });
  assert.deepEqual(seen, ['armed', 'draining', 'human']);
  assert.equal(getSessionInputOwnership('client-session').mode, 'unavailable');
});

test('old unsubscribe cannot remove a newer subscription and callers cannot mutate a snapshot', () => {
  const sessionId = 'resubscribe-session';
  const removeOld = subscribeSessionInputOwnership(sessionId, () => {});
  removeOld();
  let observed = 0;
  const removeNew = subscribeSessionInputOwnership(sessionId, () => { observed += 1; });
  removeOld();
  const value: InputOwnership = { ...getSessionInputOwnership(sessionId), mode: 'armed', epoch: '1' };
  applySessionInputOwnership(value);
  value.mode = 'human';
  assert.equal(getSessionInputOwnership(sessionId).mode, 'armed');
  assert.equal(Object.isFrozen(getSessionInputOwnership(sessionId)), true);
  assert.equal(observed, 1);
  removeNew();
});
