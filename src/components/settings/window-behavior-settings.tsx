'use client';

import { useElectronPlatform } from '@/hooks/use-electron-platform';
import { useSettingsStore } from '@/stores/settings-store';
import type { WindowsCloseBehavior } from '@/lib/settings/types';
import { useI18n } from '@/lib/i18n';
import { settingsTelemetryClickAttributes } from '@/lib/telemetry/ui-click';

export default function WindowBehaviorSettings() {
  const { t } = useI18n();
  const electronPlatform = useElectronPlatform();
  const windowsCloseBehavior = useSettingsStore((state) => state.settings.windowsCloseBehavior);
  const updateSettings = useSettingsStore((state) => state.updateSettings);

  if (electronPlatform !== 'win32') return null;

  return (
    <div className="space-y-3">
      <div>
        <h3 className="font-medium text-(--text-primary)">
          {t('settings.windowsCloseBehavior.label')}
        </h3>
        <p className="mt-1 text-xs leading-5 text-(--text-muted)">
          {t('settings.windowsCloseBehavior.desc')}
        </p>
      </div>

      <select
        {...settingsTelemetryClickAttributes('settings.window.close_behavior')}
        value={windowsCloseBehavior}
        onChange={(event) =>
          void updateSettings({
            windowsCloseBehavior: event.target.value as WindowsCloseBehavior,
          })
        }
        className="w-full rounded-md border border-(--input-border) bg-(--input-bg) px-3 py-2 text-sm text-(--input-text)"
        data-testid="windows-close-behavior-select"
      >
        <option value="ask">{t('settings.windowsCloseBehavior.ask')}</option>
        <option value="tray">{t('settings.windowsCloseBehavior.tray')}</option>
        <option value="quit">{t('settings.windowsCloseBehavior.quit')}</option>
      </select>

      <p className="text-xs leading-5 text-(--text-muted)">
        {windowsCloseBehavior === 'ask'
          ? t('settings.windowsCloseBehavior.askDesc')
          : windowsCloseBehavior === 'tray'
            ? t('settings.windowsCloseBehavior.trayDesc')
            : t('settings.windowsCloseBehavior.quitDesc')}
      </p>
    </div>
  );
}
