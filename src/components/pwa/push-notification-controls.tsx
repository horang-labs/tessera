'use client';

import { useEffect, useState } from 'react';
import { Bell, BellOff, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';
import {
  pushApplicationServerKeyMatches,
  requestPushPermission,
  supportsInstalledPwaPush,
  vapidPublicKeyBytes,
} from '@/lib/push/browser-push';
import { useSettingsStore } from '@/stores/settings-store';

type DevicePushState =
  | 'checking'
  | 'not-paired'
  | 'unavailable'
  | 'ready'
  | 'subscribed'
  | 'denied'
  | 'error';

interface SubscriptionResponse {
  vapidPublicKey?: unknown;
  subscription?: unknown;
}

async function loadSubscription(): Promise<Response> {
  return fetch('/api/push/subscription', {
    cache: 'no-store',
    credentials: 'same-origin',
  });
}

export function PushNotificationControls() {
  const { t } = useI18n();
  const notifications = useSettingsStore((state) => state.settings.notifications);
  const updateSettings = useSettingsStore((state) => state.updateSettings);
  const [deviceState, setDeviceState] = useState<DevicePushState>('checking');
  const [busy, setBusy] = useState(false);

  useEffect(function inspectCurrentDeviceSubscription() {
    let cancelled = false;
    void loadSubscription().then(async (response) => {
      if (cancelled) return;
      if (response.status === 403) {
        setDeviceState('not-paired');
        return;
      }
      if (!response.ok) throw new Error('subscription-load-failed');
      const body = await response.json() as SubscriptionResponse;
      if (cancelled) return;
      if (!supportsInstalledPwaPush()) {
        setDeviceState('unavailable');
        return;
      }
      setDeviceState(body.subscription ? 'subscribed' : 'ready');
    }).catch(() => {
      if (!cancelled) setDeviceState('error');
    });
    return () => { cancelled = true; };
  }, []);

  const enableForDevice = async () => {
    setBusy(true);
    try {
      const permission = await requestPushPermission();
      if (permission !== 'granted') {
        setDeviceState('denied');
        return;
      }
      const response = await loadSubscription();
      if (!response.ok) throw new Error('subscription-load-failed');
      const body = await response.json() as SubscriptionResponse;
      if (typeof body.vapidPublicKey !== 'string') throw new Error('vapid-key-missing');

      const registration = await navigator.serviceWorker.ready;
      const applicationServerKey = vapidPublicKeyBytes(body.vapidPublicKey);
      let existing = await registration.pushManager.getSubscription();
      if (
        existing
        && !pushApplicationServerKeyMatches(
          existing.options.applicationServerKey,
          applicationServerKey,
        )
      ) {
        await existing.unsubscribe();
        existing = null;
      }
      const subscription = existing ?? await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey,
      });
      const stored = await fetch('/api/push/subscription', {
        method: 'PUT',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(subscription.toJSON()),
      });
      if (!stored.ok) throw new Error('subscription-save-failed');
      setDeviceState('subscribed');
    } catch {
      setDeviceState('error');
    } finally {
      setBusy(false);
    }
  };

  const disableForDevice = async () => {
    setBusy(true);
    try {
      const registration = await navigator.serviceWorker.ready;
      await (await registration.pushManager.getSubscription())?.unsubscribe();
      const response = await fetch('/api/push/subscription', {
        method: 'DELETE',
        credentials: 'same-origin',
      });
      if (!response.ok) throw new Error('subscription-delete-failed');
      setDeviceState('ready');
    } catch {
      setDeviceState('error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3 rounded-lg border border-(--divider) bg-(--input-bg) p-3">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="flex items-center gap-2 text-sm font-medium text-(--text-primary)">
            <Bell className="h-4 w-4 text-(--accent)" />
            {t('settings.remoteAccess.pushTitle')}
          </p>
          <p className="mt-1 text-xs leading-5 text-(--text-muted)">
            {t('settings.remoteAccess.pushDescription')}
          </p>
        </div>
        <input
          type="checkbox"
          aria-label={t('settings.remoteAccess.pushGlobalLabel')}
          data-testid="push-global-enabled"
          checked={notifications.pushEnabled}
          onChange={(event) => void updateSettings({
            notifications: { ...notifications, pushEnabled: event.target.checked },
          })}
          className="mt-1 h-4 w-4 shrink-0 accent-(--accent)"
        />
      </div>

      {deviceState !== 'not-paired' ? (
        <div className="border-t border-(--divider) pt-3">
          {deviceState === 'checking' ? (
            <p className="flex items-center gap-2 text-xs text-(--text-muted)">
              <RefreshCw className="h-3.5 w-3.5 animate-spin" />
              {t('settings.remoteAccess.pushChecking')}
            </p>
          ) : deviceState === 'unavailable' ? (
            <p className="text-xs leading-5 text-(--text-muted)">
              {t('settings.remoteAccess.pushInstallRequired')}
            </p>
          ) : deviceState === 'denied' ? (
            <p data-testid="push-device-denied" className="text-xs leading-5 text-(--status-warning-text)">
              {t('settings.remoteAccess.pushDenied')}
            </p>
          ) : deviceState === 'error' ? (
            <p role="alert" className="text-xs leading-5 text-(--status-error-text)">
              {t('settings.remoteAccess.pushFailed')}
            </p>
          ) : deviceState === 'subscribed' ? (
            <div className="flex items-center justify-between gap-3">
              <p className="text-xs text-(--status-success-text)">
                {t('settings.remoteAccess.pushDeviceEnabled')}
              </p>
              <Button
                type="button"
                variant="outline"
                onClick={() => void disableForDevice()}
                disabled={busy}
                data-testid="push-device-disable"
              >
                <BellOff className="h-4 w-4" />
                {t('settings.remoteAccess.pushDisableDevice')}
              </Button>
            </div>
          ) : (
            <Button
              type="button"
              onClick={() => void enableForDevice()}
              disabled={busy}
              data-testid="push-device-enable"
            >
              {busy ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Bell className="h-4 w-4" />}
              {t('settings.remoteAccess.pushEnableDevice')}
            </Button>
          )}
        </div>
      ) : null}
    </div>
  );
}
