'use client';

import { useCallback, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { AsyncConfirmDialog } from '@/components/ui/async-confirm-dialog';
import { useI18n } from '@/lib/i18n';
import { requiresArchivedWorktreeRetentionConfirmation } from '@/lib/settings/archived-worktree-retention';
import { useSettingsStore } from '@/stores/settings-store';
import type { UserSettings } from '@/lib/settings/types';
import type { TelemetryTarget } from '@/lib/telemetry/ui-click';

interface PendingRetentionChange {
  partial: Partial<UserSettings>;
  previousDays: number;
  nextDays: number;
  enablesAutoDelete: boolean;
}

type WorktreeRetentionSurface = 'settings' | 'archive';

interface UseWorktreeRetentionSettingsUpdateOptions {
  surface: WorktreeRetentionSurface;
  onApplied?: () => void | Promise<void>;
}

function retentionDialogTelemetry(surface: WorktreeRetentionSurface): {
  cancel: TelemetryTarget;
  confirm: TelemetryTarget;
} {
  if (surface === 'archive') {
    return {
      cancel: { control: 'archive.dialog.cancel', surface: 'archive' },
      confirm: { control: 'archive.dialog.confirm', surface: 'archive' },
    };
  }

  return {
    cancel: { control: 'settings.development.worktree_retention_cancel', surface: 'settings' },
    confirm: { control: 'settings.development.worktree_retention_confirm', surface: 'settings' },
  };
}

export function useWorktreeRetentionSettingsUpdate({
  surface,
  onApplied,
}: UseWorktreeRetentionSettingsUpdateOptions) {
  const { t } = useI18n();
  const settings = useSettingsStore((state) => state.settings);
  const updateSettings = useSettingsStore((state) => state.updateSettings);
  const loadSettings = useSettingsStore((state) => state.load);
  const [pendingRetentionChange, setPendingRetentionChange] = useState<PendingRetentionChange | null>(null);
  const [retentionDaysDraft, setRetentionDaysDraft] = useState<string | null>(null);
  const dialogTelemetry = retentionDialogTelemetry(surface);

  const applySettingsUpdate = useCallback(async (
    partial: Partial<UserSettings>,
    confirmArchivedWorktreePrune = false,
  ) => {
    const saved = await updateSettings(partial, { confirmArchivedWorktreePrune });
    if (saved.ok) {
      await onApplied?.();
    }
    return saved;
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

    const result = await applySettingsUpdate(partial);
    if (result.code === 'archived_worktree_retention_confirmation_required') {
      const loaded = await loadSettings();
      if (!loaded) return;
      const latestSettings = useSettingsStore.getState().settings;
      const latestNextSettings = { ...latestSettings, ...partial };
      if (requiresArchivedWorktreeRetentionConfirmation(latestSettings, latestNextSettings)) {
        setPendingRetentionChange({
          partial,
          previousDays: latestSettings.archivedWorktreeRetentionDays,
          nextDays: latestNextSettings.archivedWorktreeRetentionDays,
          enablesAutoDelete:
            !latestSettings.autoDeleteArchivedWorktrees
            && latestNextSettings.autoDeleteArchivedWorktrees,
        });
        return;
      }

      // The rejected full snapshot may have contained stale retention values even
      // when this partial changed an unrelated setting. Retry once from the
      // authoritative snapshot instead of asking for destructive confirmation.
      await applySettingsUpdate(partial);
    }
  }, [applySettingsUpdate, loadSettings, settings]);

  const commitRetentionDays = useCallback(async () => {
    if (retentionDaysDraft === null) return;
    const parsed = Number(retentionDaysDraft);
    const nextDays = Math.min(365, Math.max(1, Number.isFinite(parsed) ? Math.floor(parsed) : 1));
    setRetentionDaysDraft(null);
    if (nextDays === settings.archivedWorktreeRetentionDays) return;
    await requestSettingsUpdate({ archivedWorktreeRetentionDays: nextDays });
  }, [requestSettingsUpdate, retentionDaysDraft, settings.archivedWorktreeRetentionDays]);

  const cancelRetentionChange = useCallback(() => {
    setPendingRetentionChange(null);
  }, []);

  const confirmRetentionChange = useCallback(async () => {
    if (!pendingRetentionChange) return;
    const { partial } = pendingRetentionChange;
    const saved = await applySettingsUpdate(partial, true);
    if (!saved.ok) {
      throw new Error('Failed to save archived Worktree retention settings');
    }
    setPendingRetentionChange(null);
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
      cancelTelemetry={dialogTelemetry.cancel}
      confirmTelemetry={dialogTelemetry.confirm}
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
    retentionDaysInputValue:
      retentionDaysDraft ?? String(settings.archivedWorktreeRetentionDays),
    setRetentionDaysDraft,
    commitRetentionDays,
    retentionConfirmDialog,
  };
}
