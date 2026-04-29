'use client';

import { useSettingsStore } from '@/stores/settings-store';
import { useI18n } from '@/lib/i18n';
import type { Language } from '@/lib/settings/types';

export default function LanguageSwitcher() {
  const { t } = useI18n();
  const language = useSettingsStore((state) => state.settings.language);
  const updateSettings = useSettingsStore((state) => state.updateSettings);

  return (
    <div className="space-y-2">
      <label className="block text-sm font-medium text-(--text-secondary)">{t('settings.language')}</label>
      <select
        value={language}
        onChange={(e) => updateSettings({ language: e.target.value as Language })}
        className="w-full px-3 py-2 border border-(--input-border) rounded-md bg-(--input-bg) text-(--text-primary) focus:outline-none focus:ring-1 focus:ring-(--accent)"
      >
        <option value="en">English</option>
        <option value="zh">中文</option>
        <option value="ko">한국어</option>
        <option value="ja">日本語</option>
      </select>
    </div>
  );
}
