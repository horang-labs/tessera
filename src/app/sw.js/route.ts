const SERVICE_WORKER = `
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
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
