import assert from 'node:assert/strict';
import test from 'node:test';
import { useNotificationStore } from '../src/stores/notification-store';

test('Autorun attention and native approval coexist, and replay or dismissal never repeats attention', () => {
  const store = useNotificationStore;
  store.setState({ notifications: [] });
  const attention = { kind: 'rule' as const, automationId: 'rule-1', revision: 2, sessionId: 'session-1', decisionId: null, outcome: 'error' as const, reason: 'CONTEXT_UNAVAILABLE' as const };
  store.getState().addNotification({ sessionId: 'session-1', type: 'permission_request', preview: 'Native approval' });
  const item = { sessionId: 'session-1', type: 'autorun_attention' as const, attention, preview: 'Latest context unavailable', dedupKey: 'autorun:rule-1:2:CONTEXT_UNAVAILABLE' };
  assert.equal(store.getState().addNotification(item), true);
  assert.equal(store.getState().notifications.filter(n => !n.dismissed).length, 2);
  assert.equal(store.getState().addNotification(item), false);
  store.getState().dismissNotification(store.getState().notifications[0].id);
  assert.equal(store.getState().addNotification(item), false);
});
