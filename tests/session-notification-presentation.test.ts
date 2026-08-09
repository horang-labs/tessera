import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createSessionNotificationPresenter,
  type PageSessionNotification,
} from '../src/lib/notifications/session-notification-presentation';

function notification(eventId: string, source: PageSessionNotification['source']) {
  return {
    eventId,
    source,
    kind: 'permission_request' as const,
    sessionId: 'session-1',
    title: 'Permission requested.',
    preview: 'Bash is requesting permission to run',
    url: '/chat?session=session-1&prompt=tool-1',
  };
}

test('WebSocket and service-worker arrival orders each present one Session Notification', () => {
  for (const sources of [
    ['websocket', 'service-worker'],
    ['service-worker', 'websocket'],
  ] as const) {
    const presented: PageSessionNotification[] = [];
    const present = createSessionNotificationPresenter({
      maxRecentEvents: 100,
      present: (value) => presented.push(value),
    });

    assert.equal(present(notification('shared-event', sources[0])), true);
    assert.equal(present(notification('shared-event', sources[1])), false);
    assert.equal(presented.length, 1);
    assert.equal(presented[0].source, sources[0]);
  }
});

test('the bounded recent-event set eventually admits an evicted event ID', () => {
  const presented: PageSessionNotification[] = [];
  const present = createSessionNotificationPresenter({
    maxRecentEvents: 2,
    present: (value) => presented.push(value),
  });

  present(notification('event-1', 'websocket'));
  present(notification('event-2', 'websocket'));
  present(notification('event-3', 'service-worker'));
  assert.equal(present(notification('event-1', 'service-worker')), true);
  assert.deepEqual(presented.map(({ eventId }) => eventId), [
    'event-1', 'event-2', 'event-3', 'event-1',
  ]);
});
