'use client';

import { useEffect, useRef } from 'react';
import { useSessionNavigation } from '@/hooks/use-session-navigation';
import { useI18n } from '@/lib/i18n';
import { openSessionSurface } from '@/lib/session/open-session-surface';
import { getElectronPlatform } from '@/lib/workspace-tabs/file-path-actions';
import { wsClient } from '@/lib/ws/client';
import { toast } from '@/stores/notification-store';

/**
 * Show a Session when the Tessera CLI asks for it (`tessera session open`).
 *
 * Every window of the user receives the request. The desktop app always takes
 * it: Windows reports a window merely covered by another app as hidden, and the
 * user often switches away while the agent searches. A browser takes it only
 * while visible, so a phone in a pocket does not jump to another Session. The
 * answer tells the CLI whether anything was shown.
 */
export function SessionOpenRequestListener() {
  const { t } = useI18n();
  const { materializeSession, viewSession } = useSessionNavigation();
  const latest = useRef({ materializeSession, viewSession, t });
  latest.current = { materializeSession, viewSession, t };

  useEffect(() => wsClient.subscribeServerMessages((message) => {
    if (message.type !== 'session_open_request') return;
    if (getElectronPlatform() === null && document.visibilityState !== 'visible') {
      wsClient.respondSessionOpen(message.openId, false);
      return;
    }
    void (async () => {
      const { materializeSession: materialize, viewSession: view, t: translate } = latest.current;
      let opened = false;
      try {
        const result = await openSessionSurface(message.sessionId, {
          materializeSession: materialize,
          viewSession: view,
        });
        opened = result.status === 'opened';
        if (result.status === 'not_found') toast.error(translate('errors.sessionNotFound'));
        if (result.status === 'opened' && result.historyLoad) {
          result.historyLoad.catch(() => toast.error(translate('errors.sessionLoadFailed')));
        }
      } finally {
        wsClient.respondSessionOpen(message.openId, opened);
      }
    })();
  }), []);

  return null;
}
