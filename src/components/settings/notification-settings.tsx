'use client';

import { useSettingsStore } from '@/stores/settings-store';
import { useI18n } from '@/lib/i18n';
import { settingsTelemetryClickAttributes } from '@/lib/telemetry/ui-click';

export default function NotificationSettings() {
  const { t } = useI18n();
  const notifications = useSettingsStore((state) => state.settings.notifications);
  const updateSettings = useSettingsStore((state) => state.updateSettings);

  return (
    <div className="space-y-4">
      <h3 className="font-medium text-(--text-primary)">{t('settings.notifications')}</h3>

      <div
        {...settingsTelemetryClickAttributes('settings.notifications.sound')}
        className="flex items-center justify-between"
      >
        <label htmlFor="sound" className="text-sm text-(--text-secondary)">
          {t('settings.sound')}
        </label>
        <input
          {...settingsTelemetryClickAttributes('settings.notifications.sound')}
          type="checkbox"
          id="sound"
          checked={notifications.soundEnabled}
          onChange={(e) =>
            updateSettings({
              notifications: { ...notifications, soundEnabled: e.target.checked },
            })
          }
          className="w-4 h-4 accent-(--accent)"
        />
      </div>

      <div
        {...settingsTelemetryClickAttributes('settings.notifications.toast')}
        className="flex items-center justify-between"
      >
        <label htmlFor="toast" className="text-sm text-(--text-secondary)">
          {t('settings.toast')}
        </label>
        <input
          {...settingsTelemetryClickAttributes('settings.notifications.toast')}
          type="checkbox"
          id="toast"
          checked={notifications.showToast}
          onChange={(e) =>
            updateSettings({
              notifications: { ...notifications, showToast: e.target.checked },
            })
          }
          className="w-4 h-4 accent-(--accent)"
        />
      </div>

      <div
        {...settingsTelemetryClickAttributes('settings.notifications.ai_title_generation')}
        className="flex items-center justify-between"
      >
        <div className="flex flex-col gap-0.5">
          <label htmlFor="aiTitleRefinement" className="text-sm text-(--text-secondary)">
            {t('settings.aiTitleRefinement')}
          </label>
          <span className="text-[11px] text-(--text-tertiary)">
            {t('settings.aiTitleRefinementDesc')}
          </span>
        </div>
        <input
          {...settingsTelemetryClickAttributes('settings.notifications.ai_title_generation')}
          type="checkbox"
          id="aiTitleRefinement"
          checked={notifications.aiTitleRefinement ?? false}
          onChange={(e) =>
            updateSettings({
              notifications: { ...notifications, aiTitleRefinement: e.target.checked },
            })
          }
          className="w-4 h-4 accent-(--accent)"
        />
      </div>
    </div>
  );
}
