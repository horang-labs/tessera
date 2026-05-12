'use client';

import { useSettingsStore } from '@/stores/settings-store';
import { useI18n } from '@/lib/i18n';
import {
  DEFAULT_FONT_SCALE,
  FONT_SCALE_OPTIONS,
  normalizeFontScale,
} from '@/lib/settings/provider-defaults';

const PRESET_LABEL_KEYS = ['small', 'medium', 'large', 'xlarge'] as const;

export default function AppearanceSettings() {
  const { t } = useI18n();
  const theme = useSettingsStore((state) => state.settings.theme);
  const fontSize = useSettingsStore((state) => state.settings.fontSize);
  const inactivePanelDimming = useSettingsStore((state) => state.settings.inactivePanelDimming);
  const showProviderIcons = useSettingsStore((state) => state.settings.showProviderIcons);
  const updateSettings = useSettingsStore((state) => state.updateSettings);

  // Theme and font scale are applied globally by ThemeInitializer.

  const currentScale = normalizeFontScale(fontSize);
  const currentIndex = Math.max(
    0,
    FONT_SCALE_OPTIONS.findIndex((s) => s === currentScale),
  );
  const activeIndex = currentIndex === -1 ? FONT_SCALE_OPTIONS.indexOf(DEFAULT_FONT_SCALE) : currentIndex;
  const activeLabel = t(`settings.fontSizePresets.${PRESET_LABEL_KEYS[activeIndex]}`);

  return (
    <div className="space-y-4">
      <h3 className="font-medium text-(--text-primary)">{t('settings.appearance')}</h3>

      <div className="space-y-2">
        <label className="block text-sm font-medium text-(--text-secondary)">{t('settings.theme.label')}</label>
        <select
          value={theme}
          onChange={(e) => updateSettings({ theme: e.target.value as 'light' | 'dark' | 'auto' })}
          className="w-full px-3 py-2 border border-(--input-border) rounded-md bg-(--input-bg) text-(--text-primary) focus:outline-none focus:ring-1 focus:ring-(--accent)"
        >
          <option value="light">{t('settings.theme.light')}</option>
          <option value="dark">{t('settings.theme.dark')}</option>
          <option value="auto">{t('settings.theme.auto')}</option>
        </select>
      </div>

      <div className="space-y-2">
        <label className="block text-sm font-medium text-(--text-secondary)">
          {t('settings.fontSize')} ({activeLabel})
        </label>
        <input
          type="range"
          min={0}
          max={FONT_SCALE_OPTIONS.length - 1}
          step={1}
          value={activeIndex}
          onChange={(e) => updateSettings({ fontSize: FONT_SCALE_OPTIONS[parseInt(e.target.value)] })}
          className="w-full accent-(--accent)"
        />
        <div className="flex justify-between text-xs text-(--text-muted)">
          {PRESET_LABEL_KEYS.map((key) => (
            <span key={key}>{t(`settings.fontSizePresets.${key}`)}</span>
          ))}
        </div>
      </div>

      <div className="space-y-2">
        <label className="block text-sm font-medium text-(--text-secondary)">
          {t('settings.inactivePanelDimming')} ({inactivePanelDimming}%)
        </label>
        <input
          type="range"
          min="0"
          max="100"
          step="5"
          value={inactivePanelDimming}
          onChange={(e) => updateSettings({ inactivePanelDimming: parseInt(e.target.value) })}
          className="w-full accent-(--accent)"
        />
      </div>

      <label className="flex items-start gap-3 rounded-md border border-(--divider) bg-(--sidebar-bg) px-3 py-2.5">
        <input
          type="checkbox"
          checked={showProviderIcons}
          onChange={(e) => updateSettings({ showProviderIcons: e.target.checked })}
          className="mt-0.5 h-4 w-4 accent-(--accent)"
        />
        <span className="min-w-0">
          <span className="block text-sm font-medium text-(--text-secondary)">
            {t('settings.showProviderIcons')}
          </span>
          <span className="mt-0.5 block text-xs leading-5 text-(--text-muted)">
            {t('settings.showProviderIconsDesc')}
          </span>
        </span>
      </label>
    </div>
  );
}
