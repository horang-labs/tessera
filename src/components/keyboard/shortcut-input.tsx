'use client';

import { useEffect, useState } from 'react';
import { formatShortcut, detectPlatform, type Platform } from '@/lib/keyboard/format';
import { useI18n } from '@/lib/i18n';

export interface ShortcutInputProps {
  /** Current key string (tinykeys format) or empty for disabled. */
  value: string;
  /** Called with new key string. Empty string = clear/disable. Not called on cancel. */
  onChange: (value: string) => void;
  /** Override platform detection (tests). */
  platform?: Platform;
  className?: string;
}

const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'OS']);

function eventToShortcut(e: KeyboardEvent): string | null {
  if (MODIFIER_KEYS.has(e.key)) return null;

  const parts: string[] = [];
  if (e.metaKey || e.ctrlKey) parts.push('$mod');
  if (e.altKey)               parts.push('Alt');
  if (e.shiftKey)             parts.push('Shift');

  let main = e.key;
  if (main.length === 1) main = main.toLowerCase();
  parts.push(main);

  return parts.join('+');
}

export function ShortcutInput({ value, onChange, platform, className }: ShortcutInputProps) {
  const { t } = useI18n();
  const [editing, setEditing] = useState(false);
  const plat = platform ?? detectPlatform();

  useEffect(() => {
    if (!editing) return;
    const onKeyDown = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') {
        setEditing(false);
        return;
      }
      if (e.key === 'Backspace') {
        onChange('');
        setEditing(false);
        return;
      }
      const shortcut = eventToShortcut(e);
      if (!shortcut) return;
      onChange(shortcut);
      setEditing(false);
    };
    window.addEventListener('keydown', onKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true });
  }, [editing, onChange]);

  const display = editing
    ? t('settings.shortcutInput.pressKey')
    : (value ? formatShortcut(value, plat) : '—');

  return (
    <button
      type="button"
      onClick={() => setEditing(true)}
      className={`px-2 py-1 text-xs font-mono rounded border ${
        editing
          ? 'border-(--accent) bg-(--input-bg) text-(--accent)'
          : 'border-(--input-border) bg-(--input-bg) text-(--text-secondary)'
      } ${className ?? ''}`}
    >
      {display}
    </button>
  );
}
