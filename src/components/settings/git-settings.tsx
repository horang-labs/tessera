'use client';

import { useSettingsStore } from '@/stores/settings-store';
import { useI18n } from '@/lib/i18n';
import { useProviderSessionOptions } from '@/hooks/use-provider-session-options';
import type { GitConfig } from '@/lib/settings/types';

const PROVIDER_OPTIONS = ['claude-code', 'codex', 'opencode'] as const;
const SELECT_CLASS =
  'w-52 px-3 py-1.5 border border-(--input-border) rounded-md bg-(--input-bg) text-(--text-primary) text-sm focus:outline-none focus:ring-1 focus:ring-(--accent) disabled:opacity-50 disabled:cursor-not-allowed';

export default function GitSettings() {
  const { t } = useI18n();
  const gitConfig = useSettingsStore((state) => state.settings.gitConfig);
  const agentEnvironment = useSettingsStore((state) => state.settings.agentEnvironment);
  const updateSettings = useSettingsStore((state) => state.updateSettings);
  const sourceControlAi = gitConfig.sourceControlAi;
  const { data: providerOptions } = useProviderSessionOptions(
    sourceControlAi.provider,
    agentEnvironment,
  );
  const isOpenCode = sourceControlAi.provider === 'opencode';

  const update = (patch: Partial<GitConfig>) => {
    void updateSettings({ gitConfig: { ...gitConfig, ...patch } });
  };

  const updateSourceControlAi = (
    patch: Partial<GitConfig['sourceControlAi']>,
  ) => {
    update({ sourceControlAi: { ...sourceControlAi, ...patch } });
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

        <div className="space-y-3 px-4 py-3">
          <div className="flex flex-col gap-0.5">
            <span className="text-sm text-(--text-primary)">
              {t('settings.gitConfig.sourceControlAi')}
            </span>
            <span className="text-[11px] text-(--text-tertiary)">
              {t('settings.gitConfig.sourceControlAiDesc')}
            </span>
          </div>

          <div className="flex items-center justify-between gap-4">
            <label className="text-sm text-(--text-secondary)">
              {t('settings.gitConfig.provider')}
            </label>
            <select
              value={sourceControlAi.provider}
              onChange={(event) => updateSourceControlAi({
                provider: event.target.value,
                model: '',
              })}
              className={SELECT_CLASS}
            >
              {PROVIDER_OPTIONS.map((provider) => (
                <option key={provider} value={provider}>{provider}</option>
              ))}
            </select>
          </div>

          <div className="flex items-center justify-between gap-4">
            <label className="text-sm text-(--text-secondary)">
              {t('settings.gitConfig.model')}
            </label>
            <select
              value={sourceControlAi.model ?? ''}
              onChange={(event) => updateSourceControlAi({ model: event.target.value })}
              disabled={isOpenCode}
              className={SELECT_CLASS}
            >
              <option value="">{t('settings.gitConfig.modelDefault')}</option>
              {(providerOptions?.modelOptions ?? []).map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </div>
          {isOpenCode ? (
            <p className="text-[11px] text-(--text-tertiary)">
              {t('settings.gitConfig.opencodeModelNote')}
            </p>
          ) : null}
        </div>

      </div>
    </div>
  );
}
