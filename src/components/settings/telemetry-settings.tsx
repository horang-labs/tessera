'use client';

import { useSettingsStore } from '@/stores/settings-store';
import { useI18n } from '@/lib/i18n';
import { captureTelemetryOptOut } from '@/lib/telemetry/client';
import { settingsTelemetryClickAttributes } from '@/lib/telemetry/ui-click';

export default function TelemetrySettings() {
  const { t } = useI18n();
  const telemetry = useSettingsStore((state) => state.settings.telemetry);
  const telemetryDisabledByEnv = useSettingsStore(
    (state) => state.serverHostInfo?.telemetryDisabledByEnv ?? false,
  );
  const updateSettings = useSettingsStore((state) => state.updateSettings);

  const updateTelemetryEnabled = async (enabled: boolean) => {
    if (!enabled && telemetry.enabled && !telemetryDisabledByEnv) {
      await captureTelemetryOptOut('settings');
    }

    await updateSettings({
      telemetry: { ...telemetry, enabled },
    });
  };

  return (
    <div className="space-y-3">
      <div>
        <h3 className="font-medium text-(--text-primary)">
          {t('settings.telemetry.title')}
        </h3>
        <p className="mt-1 text-xs leading-5 text-(--text-muted)">
          {t('settings.telemetry.description')}
        </p>
      </div>

      <div className="flex items-center justify-between gap-4">
        <label htmlFor="telemetry-enabled" className="text-sm text-(--text-secondary)">
          {t('settings.telemetry.enabled')}
        </label>
        <input
          {...settingsTelemetryClickAttributes('settings.telemetry.enabled')}
          type="checkbox"
          id="telemetry-enabled"
          checked={telemetry.enabled && !telemetryDisabledByEnv}
          disabled={telemetryDisabledByEnv}
          onChange={(event) =>
            void updateTelemetryEnabled(event.target.checked)
          }
          className="h-4 w-4 accent-(--accent)"
        />
      </div>

      {telemetryDisabledByEnv && (
        <p className="text-xs leading-5 text-(--text-muted)">
          {t('settings.telemetry.disabledByEnv')}
        </p>
      )}
    </div>
  );
}
