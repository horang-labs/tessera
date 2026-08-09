import {
  SESSION_NOTIFICATION_FALLBACKS,
  SESSION_NOTIFICATION_KINDS,
} from '@/lib/notifications/session-notification';

const SERVICE_WORKER = `
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

const SESSION_NOTIFICATION_KINDS = new Set(${JSON.stringify(SESSION_NOTIFICATION_KINDS)});
const SESSION_NOTIFICATION_FALLBACKS = ${JSON.stringify(SESSION_NOTIFICATION_FALLBACKS)};

function sameOriginSessionUrl(candidate) {
  try {
    const url = new URL(candidate || '/chat', self.location.origin);
    return url.origin === self.location.origin
      ? url.href
      : new URL('/chat', self.location.origin).href;
  } catch {
    return new URL('/chat', self.location.origin).href;
  }
}

self.addEventListener('push', (event) => {
  event.waitUntil((async () => {
    let payload = {};
    try {
      payload = event.data ? event.data.json() : {};
    } catch {
      payload = {};
    }
    if (!SESSION_NOTIFICATION_KINDS.has(payload.kind)
      || typeof payload.eventId !== 'string' || !payload.eventId
      || typeof payload.sessionId !== 'string') return;

    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const visibleWindows = windows.filter((client) => client.visibilityState === 'visible');
    if (visibleWindows.length > 0) {
      for (const client of visibleWindows) {
        client.postMessage({ type: 'tessera-session-notification', notification: payload });
      }
      return;
    }

    const fallback = SESSION_NOTIFICATION_FALLBACKS[payload.kind];
    const title = typeof payload.title === 'string' && payload.title.trim()
      ? payload.title
      : fallback.title;
    const preview = typeof payload.preview === 'string' && payload.preview.trim()
      ? payload.preview
      : fallback.preview;
    const url = sameOriginSessionUrl(payload.url);
    await self.registration.showNotification(title, {
      body: preview,
      icon: '/icons/tessera-192.png',
      badge: '/icons/tessera-192.png',
      tag: 'tessera-session-notification-' + payload.eventId.slice(0, 128),
      data: { url },
    });
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const url = sameOriginSessionUrl(event.notification.data && event.notification.data.url);
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const existing = windows.find((client) => new URL(client.url).origin === self.location.origin);
    if (existing) {
      if ('navigate' in existing) await existing.navigate(url);
      await existing.focus();
      return;
    }
    await self.clients.openWindow(url);
  })());
});
`;

export function GET() {
  return new Response(SERVICE_WORKER, {
    headers: {
      'Cache-Control': 'no-cache',
      'Content-Type': 'application/javascript; charset=utf-8',
      'Service-Worker-Allowed': '/',
    },
  });
}
