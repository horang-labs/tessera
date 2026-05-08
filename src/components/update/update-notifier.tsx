'use client';

import { useEffect } from 'react';
import { useI18n } from '@/lib/i18n';
import { useNotificationStore } from '@/stores/notification-store';
import { useSettingsStore } from '@/stores/settings-store';
import { isUpdateVisible, useUpdateStore } from '@/stores/update-store';

function openExternalUrl(url: string): void {
  window.open(url, '_blank', 'noopener,noreferrer');
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function UpdateNotifier() {
  const { t } = useI18n();
  const showToast = useSettingsStore((state) => state.settings.notifications?.showToast ?? true);
  const checkForUpdates = useUpdateStore((state) => state.checkForUpdates);
  const downloadUpdate = useUpdateStore((state) => state.downloadUpdate);
  const info = useUpdateStore((state) => state.info);
  const isDesktopUpdaterAvailable = useUpdateStore((state) => state.isDesktopUpdaterAvailable);
  const toastShownVersion = useUpdateStore((state) => state.toastShownVersion);
  const markToastShown = useUpdateStore((state) => state.markToastShown);
  const visible = useUpdateStore(isUpdateVisible);
  const showToastWithAction = useNotificationStore((state) => state.showToastWithAction);
  const showActionToast = useNotificationStore((state) => state.showToast);

  useEffect(() => {
    void checkForUpdates();
  }, [checkForUpdates]);

  useEffect(() => {
    const latestVersion = info?.latestVersion;
    if (!showToast || !visible || !info || !latestVersion) return;
    if (toastShownVersion === latestVersion) return;

    const hasInstallCommand = Boolean(info.installCommand);
    markToastShown(latestVersion);
    showToastWithAction(
      t('updates.toastMessage', { version: latestVersion }),
      'info',
      {
        label: isDesktopUpdaterAvailable
          ? t('updates.downloadUpdate')
          : hasInstallCommand
            ? t('updates.copyCommand')
            : t('updates.openRelease'),
        onClick: () => {
          if (isDesktopUpdaterAvailable) {
            void downloadUpdate();
            return;
          }

          if (info.installCommand) {
            void copyText(info.installCommand).then((copied) => {
              showActionToast(
                copied ? t('updates.commandCopied') : info.installCommand!,
                copied ? 'success' : 'warning',
              );
            });
            return;
          }

          if (info.releaseUrl) {
            openExternalUrl(info.releaseUrl);
          }
        },
      },
    );
  }, [
    info,
    downloadUpdate,
    isDesktopUpdaterAvailable,
    markToastShown,
    showActionToast,
    showToast,
    showToastWithAction,
    t,
    toastShownVersion,
    visible,
  ]);

  return null;
}
