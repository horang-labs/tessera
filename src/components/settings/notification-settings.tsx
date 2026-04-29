'use client';

import { useSettingsStore } from '@/stores/settings-store';
import { useI18n } from '@/lib/i18n';

export default function NotificationSettings() {
  const { t } = useI18n();
  const notifications = useSettingsStore((state) => state.settings.notifications);
  const updateSettings = useSettingsStore((state) => state.updateSettings);

  return (
    <div className="space-y-4">
      <h3 className="font-medium text-(--text-primary)">{t('settings.notifications')}</h3>

      <div className="flex items-center justify-between">
        <label htmlFor="sound" className="text-sm text-(--text-secondary)">
          {t('settings.sound')}
        </label>
        <input
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

      <div className="flex items-center justify-between">
        <label htmlFor="toast" className="text-sm text-(--text-secondary)">
          {t('settings.toast')}
        </label>
        <input
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

      <div className="flex items-center justify-between">
        <div className="flex flex-col gap-0.5">
          <label htmlFor="autoGenerateTitle" className="text-sm text-(--text-secondary)">
            {t('settings.autoGenerateTitle')}
          </label>
          <span className="text-[11px] text-(--text-tertiary)">
            {t('settings.autoGenerateTitleDesc')}
          </span>
        </div>
        <input
          type="checkbox"
          id="autoGenerateTitle"
          checked={notifications.autoGenerateTitle ?? true}
          onChange={(e) =>
            updateSettings({
              notifications: { ...notifications, autoGenerateTitle: e.target.checked },
            })
          }
          className="w-4 h-4 accent-(--accent)"
        />
      </div>
    </div>
  );
}
