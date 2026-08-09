const SERVICE_WORKER = `
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

const COMPLETED_TITLE = 'Task completed.';
const COMPLETED_PREVIEW = 'Your Tessera session completed.';

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
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (windows.some((client) => client.visibilityState === 'visible')) return;

    let payload = {};
    try {
      payload = event.data ? event.data.json() : {};
    } catch {
      payload = {};
    }
    if (payload.kind && payload.kind !== 'completed') return;

    const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : '';
    const title = typeof payload.title === 'string' && payload.title.trim()
      ? payload.title
      : COMPLETED_TITLE;
    const preview = typeof payload.preview === 'string' && payload.preview.trim()
      ? payload.preview
      : COMPLETED_PREVIEW;
    const url = sameOriginSessionUrl(payload.url);
    await self.registration.showNotification(title, {
      body: preview,
      icon: '/icons/tessera-192.png',
      badge: '/icons/tessera-192.png',
      tag: 'tessera-session-completed-' + sessionId.slice(0, 128),
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
