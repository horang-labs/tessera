'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  BellRing,
  CircleOff,
  LoaderCircle,
  RefreshCw,
  ShieldOff,
  Smartphone,
  Unplug,
} from 'lucide-react';
import { AsyncConfirmDialog } from '@/components/ui/async-confirm-dialog';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';
import { getIntlLocale } from '@/lib/i18n/locale-map';
import type { Language } from '@/lib/settings/types';
import { cn } from '@/lib/utils';
import { useNotificationStore } from '@/stores/notification-store';

interface PairedDeviceSummary {
  id: string;
  name: string;
  registeredAt: string;
  lastSeenAt: string | null;
  connected: boolean;
  hasPushSubscription: boolean;
}

interface DeviceListResponse {
  devices: PairedDeviceSummary[];
  maxDevices: number;
}

type RevocationTarget =
  | { kind: 'device'; device: PairedDeviceSummary }
  | { kind: 'all' };

const DEVICE_STATUS_REFRESH_MS = 5_000;

function isPairedDeviceSummary(value: unknown): value is PairedDeviceSummary {
  if (!value || typeof value !== 'object') return false;
  const device = value as Partial<PairedDeviceSummary>;
  return typeof device.id === 'string'
    && typeof device.name === 'string'
    && typeof device.registeredAt === 'string'
    && (device.lastSeenAt === null || typeof device.lastSeenAt === 'string')
    && typeof device.connected === 'boolean'
    && typeof device.hasPushSubscription === 'boolean';
}

async function requestDeviceList(signal?: AbortSignal): Promise<DeviceListResponse> {
  const response = await fetch('/api/devices', { cache: 'no-store', signal });
  if (!response.ok) throw new Error(`Device list request failed with status ${response.status}`);
  const body = await response.json() as Partial<DeviceListResponse>;
  if (
    !Array.isArray(body.devices)
    || !body.devices.every(isPairedDeviceSummary)
    || typeof body.maxDevices !== 'number'
  ) {
    throw new Error('Device list response is invalid');
  }
  return { devices: body.devices, maxDevices: body.maxDevices };
}

function formatDeviceDate(value: string, language: Language): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(getIntlLocale(language), {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

export default function PairedDeviceManagement() {
  const { t, language } = useI18n();
  const showToast = useNotificationStore((state) => state.showToast);
  const [devices, setDevices] = useState<PairedDeviceSummary[]>([]);
  const [maxDevices, setMaxDevices] = useState(8);
  const [isLoading, setIsLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [revocationTarget, setRevocationTarget] = useState<RevocationTarget | null>(null);
  const [revocationFailed, setRevocationFailed] = useState(false);

  const refreshDeviceList = useCallback(async ({
    signal,
    showLoading = false,
  }: {
    signal?: AbortSignal;
    showLoading?: boolean;
  } = {}) => {
    if (showLoading) setIsLoading(true);
    try {
      const next = await requestDeviceList(signal);
      setDevices(next.devices);
      setMaxDevices(next.maxDevices);
      setLoadFailed(false);
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'AbortError')) {
        setLoadFailed(true);
      }
    } finally {
      if (!signal?.aborted) setIsLoading(false);
    }
  }, []);

  useEffect(function synchronizePairedDevices() {
    const controller = new AbortController();
    void refreshDeviceList({ signal: controller.signal });
    const interval = window.setInterval(
      () => void refreshDeviceList({ signal: controller.signal }),
      DEVICE_STATUS_REFRESH_MS,
    );
    return function stopDeviceSynchronization() {
      controller.abort();
      window.clearInterval(interval);
    };
  }, [refreshDeviceList]);

  async function confirmRevocation() {
    if (!revocationTarget) return;
    setRevocationFailed(false);
    const target = revocationTarget;
    const path = revocationTarget.kind === 'all'
      ? '/api/devices'
      : `/api/devices/${encodeURIComponent(revocationTarget.device.id)}`;
    try {
      const response = await fetch(path, { method: 'DELETE' });
      if (!response.ok) throw new Error(`Device revocation failed with status ${response.status}`);
    } catch {
      setRevocationFailed(true);
      return;
    }

    const wasAll = target.kind === 'all';
    setDevices((current) => target.kind === 'all'
      ? []
      : current.filter((device) => device.id !== target.device.id));
    setRevocationTarget(null);
    setLoadFailed(false);
    showToast(
      t(wasAll
        ? 'settings.remoteAccess.allDevicesDisconnected'
        : 'settings.remoteAccess.deviceDisconnected'),
      'success',
    );
  }

  const atCapacity = devices.length >= maxDevices;
  const selectedDevice = revocationTarget?.kind === 'device'
    ? revocationTarget.device
    : null;

  return (
    <div className="border-t border-(--divider) pt-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h4 className="text-sm font-medium text-(--text-primary)">
              {t('settings.remoteAccess.deviceListTitle')}
            </h4>
            <span
              className={cn(
                'rounded-full border px-2 py-0.5 text-[11px] font-semibold tabular-nums',
                atCapacity
                  ? 'border-(--status-warning-border) bg-(--status-warning-bg) text-(--status-warning-text)'
                  : 'border-(--divider) bg-(--chat-bg) text-(--text-muted)',
              )}
            >
              {t('settings.remoteAccess.deviceCount', {
                count: devices.length,
                max: maxDevices,
              })}
            </span>
          </div>
          <p className="mt-1 text-xs leading-5 text-(--text-muted)">
            {t('settings.remoteAccess.deviceListDescription')}
          </p>
        </div>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={() => void refreshDeviceList({ showLoading: true })}
          disabled={isLoading}
          aria-label={t('settings.remoteAccess.refreshDevices')}
          title={t('settings.remoteAccess.refreshDevices')}
          className="shrink-0"
        >
          <RefreshCw className={cn('h-3.5 w-3.5', isLoading && 'animate-spin')} />
        </Button>
      </div>

      {atCapacity ? (
        <div
          data-testid="paired-device-capacity"
          className="mt-3 rounded-lg border border-(--status-warning-border) bg-(--status-warning-bg) px-3 py-2 text-xs leading-5 text-(--status-warning-text)"
        >
          {t('settings.remoteAccess.capacityReachedDescription', { max: maxDevices })}
        </div>
      ) : null}

      {loadFailed ? (
        <div className="mt-3 flex items-center justify-between gap-3 rounded-lg border border-(--status-error-border) bg-(--status-error-bg) px-3 py-2 text-xs text-(--status-error-text)" role="alert">
          <span>{t('settings.remoteAccess.deviceListFailed')}</span>
          <button type="button" className="font-semibold underline" onClick={() => void refreshDeviceList({ showLoading: true })}>
            {t('common.retry')}
          </button>
        </div>
      ) : null}

      {isLoading && devices.length === 0 ? (
        <div className="mt-4 flex items-center gap-2 py-6 text-sm text-(--text-muted)">
          <LoaderCircle className="h-4 w-4 animate-spin" />
          {t('settings.remoteAccess.loadingDevices')}
        </div>
      ) : devices.length === 0 ? (
        <div
          data-testid="paired-device-empty"
          className="mt-4 flex flex-col items-center rounded-xl border border-dashed border-(--divider) bg-(--chat-bg)/55 px-5 py-8 text-center"
        >
          <span className="flex h-10 w-10 items-center justify-center rounded-full border border-(--divider) bg-(--input-bg) text-(--text-muted)">
            <CircleOff className="h-4 w-4" />
          </span>
          <p className="mt-3 text-sm font-medium text-(--text-primary)">
            {t('settings.remoteAccess.noDevicesTitle')}
          </p>
          <p className="mt-1 max-w-sm text-xs leading-5 text-(--text-muted)">
            {t('settings.remoteAccess.noDevicesDescription')}
          </p>
        </div>
      ) : (
        <div className="mt-4 space-y-2" aria-live="polite">
          {devices.map((device) => (
            <article
              key={device.id}
              data-testid={`paired-device-${device.id}`}
              className={cn(
                'relative overflow-hidden rounded-xl border bg-(--input-bg)/70 p-3.5 transition-colors',
                device.connected
                  ? 'border-(--status-success-border)'
                  : 'border-(--divider)',
              )}
            >
              {device.connected ? (
                <span className="absolute inset-y-0 left-0 w-1 bg-(--status-success-text)" aria-hidden="true" />
              ) : null}
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
                <div className="flex min-w-0 flex-1 items-start gap-3">
                  <span className={cn(
                    'flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border',
                    device.connected
                      ? 'border-(--status-success-border) bg-(--status-success-bg) text-(--status-success-text)'
                      : 'border-(--divider) bg-(--chat-bg) text-(--text-muted)',
                  )}>
                    <Smartphone className="h-4 w-4" />
                  </span>

                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <p className="truncate text-sm font-semibold text-(--text-primary)">{device.name}</p>
                      {device.connected ? (
                        <span
                          data-testid={`paired-device-${device.id}-status`}
                          className="inline-flex items-center gap-1.5 rounded-full bg-(--status-success-bg) px-2 py-0.5 text-[11px] font-semibold text-(--status-success-text)"
                        >
                          <span className="h-1.5 w-1.5 rounded-full bg-current shadow-[0_0_0_3px_var(--status-success-bg)]" aria-hidden="true" />
                          {t('settings.remoteAccess.connectedNow')}
                        </span>
                      ) : null}
                      {device.hasPushSubscription ? (
                        <span
                          data-testid={`paired-device-${device.id}-push-status`}
                          className="inline-flex items-center gap-1.5 rounded-full border border-(--divider) bg-(--chat-bg) px-2 py-0.5 text-[11px] font-semibold text-(--text-secondary)"
                        >
                          <BellRing className="h-3 w-3" aria-hidden="true" />
                          {t('settings.remoteAccess.pushStatusEnabled')}
                        </span>
                      ) : null}
                    </div>

                    <dl className="mt-2 grid gap-1 text-xs sm:grid-cols-2 sm:gap-x-4">
                      <div className="min-w-0">
                        <dt className="inline text-(--text-muted)">{t('settings.remoteAccess.registeredAt')}: </dt>
                        <dd className="inline text-(--text-secondary)">{formatDeviceDate(device.registeredAt, language)}</dd>
                      </div>
                      <div className="min-w-0">
                        <dt className="inline text-(--text-muted)">{t('settings.remoteAccess.lastSeenAt')}: </dt>
                        <dd className="inline text-(--text-secondary)">
                          {device.lastSeenAt
                            ? formatDeviceDate(device.lastSeenAt, language)
                            : t('settings.remoteAccess.neverConnected')}
                        </dd>
                      </div>
                    </dl>
                  </div>
                </div>

                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  data-testid={`paired-device-${device.id}-disconnect`}
                  onClick={() => {
                    setRevocationFailed(false);
                    setRevocationTarget({ kind: 'device', device });
                  }}
                  className="w-full shrink-0 justify-center border-(--status-error-border) text-(--status-error-text) hover:bg-(--status-error-bg) sm:w-auto"
                >
                  <Unplug className="h-3.5 w-3.5" />
                  {t('settings.remoteAccess.disconnect')}
                </Button>
              </div>
            </article>
          ))}
        </div>
      )}

      {devices.length > 0 ? (
        <div className="mt-4 flex flex-col gap-2 rounded-xl border border-(--status-error-border) bg-(--status-error-bg) p-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <p className="text-sm font-medium text-(--status-error-text)">
              {t('settings.remoteAccess.disableAll')}
            </p>
            <p className="mt-0.5 text-xs leading-5 text-(--text-muted)">
              {t('settings.remoteAccess.disableAllDescription')}
            </p>
          </div>
          <Button
            type="button"
            size="sm"
            variant="outline"
            data-testid="paired-device-disable-all"
            onClick={() => {
              setRevocationFailed(false);
              setRevocationTarget({ kind: 'all' });
            }}
            className="shrink-0 border-(--status-error-border) text-(--status-error-text) hover:bg-(--status-error-bg)"
          >
            <ShieldOff className="h-3.5 w-3.5" />
            {t('settings.remoteAccess.disableAll')}
          </Button>
        </div>
      ) : null}

      <AsyncConfirmDialog
        open={revocationTarget !== null}
        onCancel={() => setRevocationTarget(null)}
        onConfirm={confirmRevocation}
        title={t(selectedDevice
          ? 'settings.remoteAccess.disconnectTitle'
          : 'settings.remoteAccess.disableAllTitle')}
        icon={selectedDevice ? Unplug : ShieldOff}
        cancelLabel={t('common.cancel')}
        confirmLabel={t(selectedDevice
          ? 'settings.remoteAccess.disconnectConfirm'
          : 'settings.remoteAccess.disableAllConfirm')}
        confirmingLabel={t(selectedDevice
          ? 'settings.remoteAccess.disconnecting'
          : 'settings.remoteAccess.disablingAll')}
        iconContainerClassName="bg-(--error)/10"
        iconClassName="text-(--error)"
        confirmButtonClassName="bg-(--error) text-white hover:bg-(--error)/90"
        dialogTestId={selectedDevice
          ? 'paired-device-disconnect-dialog'
          : 'paired-device-disable-all-dialog'}
        cancelTestId={selectedDevice ? 'paired-device-disconnect-cancel' : undefined}
        confirmTestId={selectedDevice
          ? 'paired-device-disconnect-confirm'
          : 'paired-device-disable-all-confirm'}
        errorLogLabel="Device revocation error:"
        description={(
          <div className="space-y-2">
            <p className="text-(--text-primary)">
              {selectedDevice
                ? t('settings.remoteAccess.disconnectDescription', { name: selectedDevice.name })
                : t('settings.remoteAccess.disableAllConfirmDescription', { count: devices.length })}
            </p>
            <p className="text-sm text-(--text-muted)">
              {t(selectedDevice
                ? 'settings.remoteAccess.disconnectWarning'
                : 'settings.remoteAccess.disableAllWarning')}
            </p>
            {revocationFailed ? (
              <p className="flex items-center gap-2 rounded-lg border border-(--status-error-border) bg-(--status-error-bg) px-3 py-2 text-sm text-(--status-error-text)" role="alert">
                <CircleOff className="h-4 w-4 shrink-0" />
                {t('settings.remoteAccess.disconnectFailed')}
              </p>
            ) : null}
          </div>
        )}
      />
    </div>
  );
}
