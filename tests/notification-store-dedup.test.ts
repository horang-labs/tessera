import assert from 'node:assert/strict';
import test from 'node:test';
import { useNotificationStore } from '@/stores/notification-store';

function reset(): void {
  useNotificationStore.setState({ notifications: [] });
}

test('addNotification with a dedupKey ignores a second identical dedupKey and returns false', () => {
  reset();
  const store = useNotificationStore.getState();

  const first = store.addNotification({
    sessionId: 's1',
    type: 'completed',
    preview: 'done',
    dedupKey: 's1:100',
  });
  const second = store.addNotification({
    sessionId: 's1',
    type: 'completed',
    preview: 'done again',
    dedupKey: 's1:100',
  });

  assert.equal(first, true);
  assert.equal(second, false);
  assert.equal(useNotificationStore.getState().notifications.length, 1);
});

test('different dedupKeys each add and return true', () => {
  reset();
  const store = useNotificationStore.getState();

  const a = store.addNotification({ sessionId: 's1', type: 'completed', preview: 'x', dedupKey: 's1:100' });
  const b = store.addNotification({ sessionId: 's1', type: 'completed', preview: 'y', dedupKey: 's1:200' });

  assert.equal(a, true);
  assert.equal(b, true);
  assert.equal(useNotificationStore.getState().notifications.length, 2);
});

test('without a dedupKey every call adds (legacy behavior) and returns true', () => {
  reset();
  const store = useNotificationStore.getState();

  const a = store.addNotification({ sessionId: 's1', type: 'completed', preview: 'x' });
  const b = store.addNotification({ sessionId: 's1', type: 'completed', preview: 'x' });

  assert.equal(a, true);
  assert.equal(b, true);
  // 같은 sessionId의 이전 알림은 dismissed 처리되지만 배열에는 남는다(기존 계약).
  assert.equal(useNotificationStore.getState().notifications.length, 2);
});
