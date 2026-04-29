'use client';

import { useEffect } from 'react';
import { useSettingsStore } from '@/stores/settings-store';
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

  return null;
}
