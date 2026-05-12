'use client';

import { useEffect } from 'react';
import { AlertTriangle, CheckCircle, Copy, Download, ExternalLink, EyeOff, RefreshCw, RotateCcw, RotateCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { useNotificationStore } from '@/stores/notification-store';
import { useUpdateStore } from '@/stores/update-store';

function formatCheckedAt(value: string | null | undefined, language: string): string {
  if (!value) return '';

  try {
    return new Intl.DateTimeFormat(language, {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(new Date(value));
  } catch {
    return value;
  }
}

async function copyInstallCommand(command: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(command);
    return true;
  } catch {
    return false;
  }
}

export default function UpdateSettings() {
  const { t, language } = useI18n();
  const status = useUpdateStore((state) => state.status);
  const info = useUpdateStore((state) => state.info);
  const error = useUpdateStore((state) => state.error);
  const desktopStatus = useUpdateStore((state) => state.desktopStatus);
  const desktopProgress = useUpdateStore((state) => state.desktopProgress);
  const isDesktopUpdaterAvailable = useUpdateStore((state) => state.isDesktopUpdaterAvailable);
  const dismissedVersion = useUpdateStore((state) => state.dismissedVersion);
  const isChecking = useUpdateStore((state) => state.isChecking);
  const isDownloading = useUpdateStore((state) => state.isDownloading);
  const checkForUpdates = useUpdateStore((state) => state.checkForUpdates);
  const downloadUpdate = useUpdateStore((state) => state.downloadUpdate);
  const installUpdate = useUpdateStore((state) => state.installUpdate);
  const dismissVersion = useUpdateStore((state) => state.dismissVersion);
  const clearDismissedVersion = useUpdateStore((state) => state.clearDismissedVersion);
  const showToast = useNotificationStore((state) => state.showToast);

  const latestVersion = info?.latestVersion ?? null;
  const currentVersion = info?.currentVersion ?? null;
  const isUpdateAvailable = info?.updateAvailable ?? false;
  const isDismissed = Boolean(latestVersion && dismissedVersion === latestVersion);
  const checkedAt = formatCheckedAt(info?.checkedAt, language);
  const isDownloaded = desktopStatus === 'downloaded';
  const canDownloadInApp = isDesktopUpdaterAvailable && isUpdateAvailable && !isDownloaded;
  const downloadPercent = Math.max(0, Math.min(100, Math.round(desktopProgress?.percent ?? 0)));

  useEffect(() => {
    if (status === 'idle') {
      void checkForUpdates();
    }
  }, [checkForUpdates, status]);

  const handleCopyCommand = async () => {
    if (!info?.installCommand) return;
    const copied = await copyInstallCommand(info.installCommand);
    showToast(copied ? t('updates.commandCopied') : info.installCommand, copied ? 'success' : 'warning');
  };

  const handleOpenRelease = () => {
    if (!info?.releaseUrl) return;
    window.open(info.releaseUrl, '_blank', 'noopener,noreferrer');
  };

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <h3 className="font-medium text-(--text-primary)">{t('updates.title')}</h3>
          <p className="text-sm leading-5 text-(--text-secondary)">
            {t('updates.description')}
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => void checkForUpdates()}
          disabled={isChecking}
          className="shrink-0"
        >
          <RefreshCw className={cn('h-3.5 w-3.5', isChecking && 'animate-spin')} />
          {t('updates.checkAgain')}
        </Button>
      </div>

      <div className="rounded-lg border border-(--divider) bg-(--chat-bg)/70 p-3">
        <div className="grid gap-3 sm:grid-cols-3">
          <div>
            <p className="text-[11px] font-medium uppercase text-(--text-muted)">
              {t('updates.currentVersion')}
            </p>
            <p className="mt-1 text-sm font-medium text-(--text-primary)">
              {currentVersion ?? t('common.loading')}
            </p>
          </div>
          <div>
            <p className="text-[11px] font-medium uppercase text-(--text-muted)">
              {t('updates.latestVersion')}
            </p>
            <p className="mt-1 text-sm font-medium text-(--text-primary)">
              {latestVersion ?? (status === 'unsupported' ? t('updates.notAvailable') : t('common.loading'))}
            </p>
          </div>
          <div>
            <p className="text-[11px] font-medium uppercase text-(--text-muted)">
              {t('updates.channel')}
            </p>
            <p className="mt-1 text-sm font-medium text-(--text-primary)">
              {info?.channel ?? '-'}
            </p>
          </div>
        </div>

        {checkedAt && (
          <p className="mt-3 text-xs text-(--text-muted)">
            {t('updates.checkedAt', { time: checkedAt })}
          </p>
        )}
      </div>

      {status === 'checking' && (
        <div className="flex items-center gap-2 text-sm text-(--text-secondary)">
          <RefreshCw className="h-4 w-4 animate-spin text-(--accent)" />
          {t('updates.checking')}
        </div>
      )}

      {status === 'error' && (
        <div className="flex items-start gap-2 rounded-lg border border-(--status-warning-border) bg-(--status-warning-bg) p-3 text-sm text-(--status-warning-text)">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <div className="min-w-0">
            <p className="font-medium">{t('updates.errorTitle')}</p>
            <p className="mt-0.5 break-words text-xs opacity-90">{error ?? t('updates.errorDescription')}</p>
          </div>
        </div>
      )}

      {status === 'unsupported' && (
        <div className="flex items-start gap-2 rounded-lg border border-(--status-info-border) bg-(--status-info-bg) p-3 text-sm text-(--status-info-text)">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <p>{t('updates.unsupported')}</p>
        </div>
      )}

      {status === 'current' && (
        <div className="flex items-start gap-2 rounded-lg border border-(--status-success-border) bg-(--status-success-bg) p-3 text-sm text-(--status-success-text)">
          <CheckCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <p>{t('updates.upToDate')}</p>
        </div>
      )}

      {isUpdateAvailable && latestVersion && (
        <div className="space-y-3 rounded-lg border border-(--status-info-border) bg-(--status-info-bg) p-3">
          <div className="flex items-start gap-2 text-sm text-(--status-info-text)">
            <CheckCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <div className="min-w-0">
              <p className="font-medium">{t('updates.availableTitle', { version: latestVersion })}</p>
              {isDismissed && (
                <p className="mt-0.5 text-xs opacity-90">{t('updates.dismissedDescription')}</p>
              )}
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            {info?.installCommand && (
              <Button type="button" size="sm" onClick={() => void handleCopyCommand()}>
                <Copy className="h-3.5 w-3.5" />
                {t('updates.copyCommand')}
              </Button>
            )}
            {canDownloadInApp && (
              <Button type="button" size="sm" onClick={() => void downloadUpdate()} disabled={isDownloading}>
                <Download className="h-3.5 w-3.5" />
                {isDownloading ? t('updates.downloading') : t('updates.downloadUpdate')}
              </Button>
            )}
            {isDownloaded && (
              <Button type="button" size="sm" onClick={() => void installUpdate()}>
                <RotateCw className="h-3.5 w-3.5" />
                {t('updates.restartInstall')}
              </Button>
            )}
            {info?.releaseUrl && !isDesktopUpdaterAvailable && (
              <Button type="button" variant={info.installCommand ? 'outline' : 'default'} size="sm" onClick={handleOpenRelease}>
                <ExternalLink className="h-3.5 w-3.5" />
                {t('updates.openRelease')}
              </Button>
            )}
            {isDismissed ? (
              <Button type="button" variant="outline" size="sm" onClick={clearDismissedVersion}>
                <RotateCcw className="h-3.5 w-3.5" />
                {t('updates.showAgain')}
              </Button>
            ) : (
              <Button type="button" variant="outline" size="sm" onClick={() => dismissVersion(latestVersion)}>
                <EyeOff className="h-3.5 w-3.5" />
                {t('updates.dismissVersion')}
              </Button>
            )}
          </div>

          {isDownloading && (
            <div className="space-y-1.5">
              <div className="h-2 overflow-hidden rounded-full bg-(--input-bg)">
                <div className="h-full rounded-full bg-(--accent)" style={{ width: `${downloadPercent}%` }} />
              </div>
              <p className="text-xs text-(--status-info-text)">
                {t('updates.downloadProgress', { percent: downloadPercent })}
              </p>
            </div>
          )}

          {isDownloaded && (
            <p className="text-xs text-(--status-info-text)">
              {t('updates.downloadedDescription')}
            </p>
          )}

          {info?.installCommand && (
            <code className="block rounded-md border border-(--input-border) bg-(--input-bg) px-2.5 py-2 text-xs text-(--text-secondary)">
              {info.installCommand}
            </code>
          )}
        </div>
      )}
    </div>
  );
}
