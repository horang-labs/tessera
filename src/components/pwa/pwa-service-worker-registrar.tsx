'use client';

import { useEffect } from 'react';
import { usePathname } from 'next/navigation';
import { isSessionNotificationPayload } from '@/lib/notifications/session-notification';
import { presentSessionNotificationOnPage } from '@/lib/notifications/session-notification-presentation';

export function PwaServiceWorkerRegistrar() {
  const pathname = usePathname();

  useEffect(function registerForAuthenticatedBrowser() {
    if (!('serviceWorker' in navigator)) return;
    let cancelled = false;
    const receiveSessionNotification = (event: MessageEvent) => {
      if (event.data?.type !== 'tessera-session-notification') return;
      if (!isSessionNotificationPayload(event.data.notification)) return;
      presentSessionNotificationOnPage({
        ...event.data.notification,
        source: 'service-worker',
      });
    };
    navigator.serviceWorker.addEventListener('message', receiveSessionNotification);

    void fetch('/api/auth/me', {
      cache: 'no-store',
      credentials: 'same-origin',
    }).then(async (response) => {
      if (!response.ok || cancelled) return;
      await navigator.serviceWorker.register('/sw.js', {
        scope: '/',
        updateViaCache: 'none',
      });
    }).catch(() => {
      // PWA support is optional; authentication and browser use remain available.
    });

    return function ignoreRegistrationAfterLeaving() {
      cancelled = true;
      navigator.serviceWorker.removeEventListener('message', receiveSessionNotification);
    };
  }, [pathname]);

  return null;
}
