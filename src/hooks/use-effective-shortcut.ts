'use client';

import { useSettingsStore } from '@/stores/settings-store';
import { getEffectiveShortcut } from '@/lib/keyboard/effective';
import type { ShortcutId } from '@/lib/keyboard/registry';

export function useEffectiveShortcut(id: ShortcutId): string | null {
  const overrides = useSettingsStore((s) => s.settings.shortcutOverrides);
  return getEffectiveShortcut(id, overrides);
}
