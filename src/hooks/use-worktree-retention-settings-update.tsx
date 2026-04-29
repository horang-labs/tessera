'use client';

import { useCallback, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { AsyncConfirmDialog } from '@/components/ui/async-confirm-dialog';
import { useI18n } from '@/lib/i18n';
import { requiresArchivedWorktreeRetentionConfirmation } from '@/lib/settings/archived-worktree-retention';
import { useSettingsStore } from '@/stores/settings-store';
import type { UserSettings } from '@/lib/settings/types';

interface PendingRetentionChange {
  partial: Partial<UserSettings>;
  previousDays: number;
  nextDays: number;
  enablesAutoDelete: boolean;
}

interface UseWorktreeRetentionSettingsUpdateOptions {
  onApplied?: () => void | Promise<void>;
}

export function useWorktreeRetentionSettingsUpdate(
  options: UseWorktreeRetentionSettingsUpdateOptions = {},
) {
  const { onApplied } = options;
  const { t } = useI18n();
  const settings = useSettingsStore((state) => state.settings);
  const updateSettings = useSettingsStore((state) => state.updateSettings);
  const [pendingRetentionChange, setPendingRetentionChange] = useState<PendingRetentionChange | null>(null);

  const applySettingsUpdate = useCallback(async (
    partial: Partial<UserSettings>,
    confirmArchivedWorktreePrune = false,
  ) => {
    await updateSettings(partial, { confirmArchivedWorktreePrune });
    await onApplied?.();
  }, [onApplied, updateSettings]);

  const requestSettingsUpdate = useCallback(async (partial: Partial<UserSettings>) => {
    const nextSettings = { ...settings, ...partial };
    if (requiresArchivedWorktreeRetentionConfirmation(settings, nextSettings)) {
      setPendingRetentionChange({
        partial,
        previousDays: settings.archivedWorktreeRetentionDays,
        nextDays: nextSettings.archivedWorktreeRetentionDays,
        enablesAutoDelete: !settings.autoDeleteArchivedWorktrees && nextSettings.autoDeleteArchivedWorktrees,
      });
      return;
    }

    await applySettingsUpdate(partial);
  }, [applySettingsUpdate, settings]);

  const cancelRetentionChange = useCallback(() => {
    setPendingRetentionChange(null);
  }, []);

  const confirmRetentionChange = useCallback(async () => {
    if (!pendingRetentionChange) return;
    const { partial } = pendingRetentionChange;
    setPendingRetentionChange(null);
    await applySettingsUpdate(partial, true);
  }, [applySettingsUpdate, pendingRetentionChange]);

  const retentionConfirmDialog = (
    <AsyncConfirmDialog
      open={pendingRetentionChange !== null}
      onCancel={cancelRetentionChange}
      onConfirm={confirmRetentionChange}
      title={t('settings.worktree.retentionConfirmTitle')}
      icon={AlertTriangle}
      cancelLabel={t('settings.worktree.retentionConfirmCancel')}
      confirmLabel={t('settings.worktree.retentionConfirmAction')}
      confirmingLabel={t('settings.worktree.retentionConfirming')}
      iconContainerClassName="bg-(--status-warning-bg)"
      iconClassName="text-(--status-warning-text)"
      confirmButtonClassName="bg-(--status-warning-text) text-white hover:bg-(--status-warning-text)/90"
      dialogTestId="worktree-retention-confirm-dialog"
      confirmTestId="worktree-retention-confirm"
      errorLogLabel="Worktree retention confirmation error:"
      description={(
        <>
          <p className="text-(--text-primary)">
            {pendingRetentionChange?.enablesAutoDelete
              ? t('settings.worktree.retentionConfirmEnableDescription', {
                days: pendingRetentionChange.nextDays,
              })
              : t('settings.worktree.retentionConfirmShortenDescription', {
                previousDays: pendingRetentionChange?.previousDays ?? settings.archivedWorktreeRetentionDays,
                nextDays: pendingRetentionChange?.nextDays ?? settings.archivedWorktreeRetentionDays,
              })}
          </p>
          <p className="mt-2 text-sm text-(--text-muted)">
            {t('settings.worktree.retentionConfirmNote')}
          </p>
        </>
      )}
    />
  );

  return {
    settings,
    updateSettings: requestSettingsUpdate,
    retentionConfirmDialog,
  };
}
