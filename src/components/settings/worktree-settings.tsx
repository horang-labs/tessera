'use client';

import { useI18n } from '@/lib/i18n';
import { useWorktreeRetentionSettingsUpdate } from '@/hooks/use-worktree-retention-settings-update';

export default function WorktreeSettings() {
  const { t } = useI18n();
  const { settings, updateSettings, retentionConfirmDialog } = useWorktreeRetentionSettingsUpdate();
  const autoDeleteArchivedWorktrees = settings.autoDeleteArchivedWorktrees;
  const archivedWorktreeRetentionDays = settings.archivedWorktreeRetentionDays;

  return (
    <>
      <div className="space-y-4">
        <h3 className="font-medium text-(--text-primary)">{t('settings.worktree.title')}</h3>

        <div className="flex items-center justify-between gap-4">
          <div className="flex flex-col gap-0.5">
            <label htmlFor="autoDeleteArchivedWorktrees" className="text-sm text-(--text-secondary)">
              {t('settings.worktree.autoDeleteArchivedWorktrees')}
            </label>
            <span className="text-[11px] text-(--text-tertiary)">
              {t('settings.worktree.autoDeleteArchivedWorktreesDesc')}
            </span>
          </div>
          <input
            id="autoDeleteArchivedWorktrees"
            type="checkbox"
            checked={autoDeleteArchivedWorktrees}
            onChange={(event) => void updateSettings({ autoDeleteArchivedWorktrees: event.target.checked })}
            className="h-4 w-4 accent-(--accent)"
          />
        </div>

        <div className="flex items-center justify-between gap-4">
          <div className="flex flex-col gap-0.5">
            <label htmlFor="archivedWorktreeRetentionDays" className="text-sm text-(--text-secondary)">
              {t('settings.worktree.retentionDays')}
            </label>
            <span className="text-[11px] text-(--text-tertiary)">
              {t('settings.worktree.retentionDaysDesc')}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <input
              id="archivedWorktreeRetentionDays"
              type="number"
              min={1}
              max={365}
              value={archivedWorktreeRetentionDays}
              onChange={(event) =>
                void updateSettings({
                  archivedWorktreeRetentionDays: Math.max(1, Number(event.target.value) || 1),
                })
              }
              className="w-20 rounded-md border border-(--input-border) bg-(--input-bg) px-3 py-2 text-sm text-(--text-primary) focus:outline-none focus:ring-1 focus:ring-(--accent)"
            />
            <span className="text-sm text-(--text-muted)">{t('settings.worktree.days')}</span>
          </div>
        </div>
      </div>
      {retentionConfirmDialog}
    </>
  );
}
