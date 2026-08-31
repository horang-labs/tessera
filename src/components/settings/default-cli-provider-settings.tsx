'use client';

import { useId } from 'react';
import { getProviderBrand, ProviderLogoMark } from '@/components/chat/provider-brand';
import { useI18n } from '@/lib/i18n';
import { DEFAULT_CLI_PROVIDER_IDS } from '@/lib/settings/default-cli-provider';
import { settingsTelemetryClickAttributes } from '@/lib/telemetry/ui-click';
import { cn } from '@/lib/utils';
import { useSettingsStore } from '@/stores/settings-store';

export default function DefaultCliProviderSettings() {
  const { t } = useI18n();
  const value = useSettingsStore((state) => state.settings.defaultCliProvider);
  const isSaving = useSettingsStore((state) => state.pendingSaveCount > 0);
  const updateSettings = useSettingsStore((state) => state.updateSettings);
  const groupId = useId();
  const descriptionId = `${groupId}-description`;
  const noteId = `${groupId}-note`;

  return (
    <fieldset
      className="space-y-3"
      disabled={isSaving}
      aria-describedby={`${descriptionId} ${noteId}`}
    >
      <legend className="font-medium text-(--text-primary)">
        {t('settings.defaultCliProvider.title')}
      </legend>
      <p id={descriptionId} className="-mt-2 text-xs leading-5 text-(--text-muted)">
        {t('settings.defaultCliProvider.description')}
      </p>

      <div className="grid gap-2 sm:grid-cols-3">
        {DEFAULT_CLI_PROVIDER_IDS.map((providerId) => {
          const selected = value === providerId;
          const inputId = `${groupId}-${providerId}`;

          return (
            <label
              key={providerId}
              {...settingsTelemetryClickAttributes('settings.general.default_cli_provider')}
              htmlFor={inputId}
              className={cn(
                'relative flex cursor-pointer items-center gap-3 rounded-xl border px-3 py-3 transition-colors',
                'has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-(--accent)',
                selected
                  ? 'border-[color-mix(in_srgb,var(--accent)_35%,transparent)] bg-[color-mix(in_srgb,var(--accent)_10%,transparent)]'
                  : 'border-(--divider) bg-(--sidebar-bg) hover:border-(--accent)/25',
                isSaving && 'cursor-wait opacity-70',
              )}
            >
              <ProviderLogoMark
                providerId={providerId}
                className="h-7 w-7 rounded-lg"
                iconClassName="h-4 w-4"
              />
              <span className="min-w-0 flex-1 text-sm font-medium text-(--text-primary)">
                {getProviderBrand(providerId).displayName}
              </span>
              <input
                {...settingsTelemetryClickAttributes('settings.general.default_cli_provider')}
                type="radio"
                id={inputId}
                name={groupId}
                value={providerId}
                checked={selected}
                onChange={() => {
                  if (selected) return;
                  void updateSettings({ defaultCliProvider: providerId });
                }}
                className="h-4 w-4 shrink-0 accent-(--accent)"
                data-testid={`default-cli-provider-${providerId}`}
              />
            </label>
          );
        })}
      </div>

      <p id={noteId} className="text-xs leading-5 text-(--text-muted)">
        {t('settings.defaultCliProvider.note')}
      </p>
    </fieldset>
  );
}
