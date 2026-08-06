'use client';

import { useSettingsStore } from '@/stores/settings-store';
import { useI18n } from '@/lib/i18n';
import type { GitConfig } from '@/lib/settings/types';

export default function GitSettings() {
  const { t } = useI18n();
  const gitConfig = useSettingsStore((state) => state.settings.gitConfig);
  const updateSettings = useSettingsStore((state) => state.updateSettings);

  const update = (patch: Partial<GitConfig>) => {
    void updateSettings({ gitConfig: { ...gitConfig, ...patch } });
  };

  return (
    <div className="space-y-4">
      <h3 className="font-medium text-(--text-primary)">
        {t('settings.gitConfig.label')}
      </h3>

      <div className="rounded-lg border border-(--divider) divide-y divide-(--divider)">
        {/* Branch prefix */}
        <div className="flex items-center justify-between px-4 py-3">
          <div className="flex flex-col gap-0.5">
            <span className="text-sm text-(--text-primary)">{t('settings.gitConfig.branchPrefix')}</span>
            <span className="text-[11px] text-(--text-tertiary)">{t('settings.gitConfig.branchPrefixDesc')}</span>
          </div>
          <input
            type="text"
            value={gitConfig.branchPrefix}
            onChange={(e) => update({ branchPrefix: e.target.value })}
            placeholder={t('settings.gitConfig.branchPrefixPlaceholder')}
            className="w-40 px-3 py-1.5 border border-(--input-border) rounded-md bg-(--input-bg) text-(--text-primary) text-sm focus:outline-none focus:ring-1 focus:ring-(--accent)"
          />
        </div>

      </div>
    </div>
  );
}
