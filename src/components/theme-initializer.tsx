'use client';

import { useEffect } from 'react';
import {
  SETTINGS_STORAGE_KEY,
  SETTINGS_SYNC_CHANNEL,
  isSettingsSyncMessage,
  useSettingsStore,
} from '@/stores/settings-store';
import { normalizeFontScale } from '@/lib/settings/provider-defaults';

function applyTheme(theme: string) {
  const root = document.documentElement;
  if (theme === 'dark') {
    root.classList.add('dark');
  } else if (theme === 'light') {
    root.classList.remove('dark');
  } else {
    // auto: follow OS preference
    const isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    root.classList.toggle('dark', isDark);
  }
}

export default function ThemeInitializer() {
  const theme = useSettingsStore((state) => state.settings.theme);
  const fontSize = useSettingsStore((state) => state.settings.fontSize);
  const applyExternalSettings = useSettingsStore((state) => state.applyExternalSettings);

  useEffect(() => {
    applyTheme(theme);

    // Listen for OS theme changes when in auto mode
    if (theme === 'auto') {
      const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
      const handler = (e: MediaQueryListEvent) => {
        document.documentElement.classList.toggle('dark', e.matches);
      };
      mediaQuery.addEventListener('change', handler);
      return () => mediaQuery.removeEventListener('change', handler);
    }
  }, [theme]);

  useEffect(() => {
    document.documentElement.style.setProperty('--font-scale', String(normalizeFontScale(fontSize)));
  }, [fontSize]);

  useEffect(function syncPersistedSettingsAcrossWindows() {
    function handlePersistedSettingsChange(event: StorageEvent) {
      if (event.key !== SETTINGS_STORAGE_KEY && event.key !== null) return;
      void useSettingsStore.persist.rehydrate();
    }

    function handleSettingsBroadcast(event: MessageEvent<unknown>) {
      if (!isSettingsSyncMessage(event.data)) return;
      applyExternalSettings(event.data.settings);
    }

    const settingsChannel = typeof window.BroadcastChannel === 'undefined'
      ? null
      : new window.BroadcastChannel(SETTINGS_SYNC_CHANNEL);

    window.addEventListener('storage', handlePersistedSettingsChange);
    settingsChannel?.addEventListener('message', handleSettingsBroadcast);

    return () => {
      window.removeEventListener('storage', handlePersistedSettingsChange);
      settingsChannel?.removeEventListener('message', handleSettingsBroadcast);
      settingsChannel?.close();
    };
  }, [applyExternalSettings]);

  return null;
}
