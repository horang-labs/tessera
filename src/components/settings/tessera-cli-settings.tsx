'use client';

import { useI18n } from '@/lib/i18n';
import { settingsTelemetryClickAttributes } from '@/lib/telemetry/ui-click';
import { useSettingsStore } from '@/stores/settings-store';

export default function TesseraCliSettings() {
  const { t } = useI18n();
  const enabled = useSettingsStore((state) => state.settings.tesseraCliEnabled);
  const isSaving = useSettingsStore((state) => state.pendingSaveCount > 0);
  const updateSettings = useSettingsStore((state) => state.updateSettings);

  return (
    <div className="space-y-3">
      <div>
        <h3 className="font-medium text-(--text-primary)">
          {t('settings.tesseraCli.title')}
        </h3>
        <p className="mt-1 text-xs leading-5 text-(--text-muted)">
          {t('settings.tesseraCli.description')}
        </p>
      </div>
      <div className="flex items-center justify-between gap-4">
        <label htmlFor="tessera-cli-enabled" className="text-sm text-(--text-secondary)">
          {t('settings.tesseraCli.enabled')}
        </label>
        <input
          {...settingsTelemetryClickAttributes('settings.development.tessera_cli_enabled')}
          id="tessera-cli-enabled"
          type="checkbox"
          checked={enabled}
          disabled={isSaving}
          onChange={(event) => {
            void updateSettings({ tesseraCliEnabled: event.target.checked });
          }}
          className="h-4 w-4 accent-(--accent)"
        />
      </div>
      <p className="text-xs leading-5 text-(--text-muted)">
        {t('settings.tesseraCli.existingSessions')}
      </p>
    </div>
  );
}
