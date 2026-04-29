'use client';

import { useState } from 'react';
import { useSettingsStore } from '@/stores/settings-store';
import { useI18n } from '@/lib/i18n';
import { SHORTCUT_REGISTRY, SHORTCUT_IDS, type ShortcutId, type ShortcutCategory } from '@/lib/keyboard/registry';
import { getEffectiveShortcut } from '@/lib/keyboard/effective';
import { formatShortcut, detectPlatform } from '@/lib/keyboard/format';
import { isBrowserConflict } from '@/lib/keyboard/conflicts';
import { ShortcutInput } from '@/components/keyboard/shortcut-input';
import { ShortcutConflictDialog } from '@/components/keyboard/shortcut-conflict-dialog';
import { useElectronPlatform } from '@/hooks/use-electron-platform';
import type { EnterKeyBehavior } from '@/lib/settings/types';

const CATEGORY_ORDER: ShortcutCategory[] = ['tab', 'view', 'panel', 'input'];

interface PendingChange {
  id: ShortcutId;
  newKey: string;
  conflictingId: ShortcutId;
}

export default function KeyboardSettings() {
  const { t } = useI18n();
  const platform = detectPlatform();
  const electronPlatform = useElectronPlatform();
  const isWebMode = !electronPlatform;
  const overrides = useSettingsStore((s) => s.settings.shortcutOverrides ?? {});
  const enterKeyBehavior = useSettingsStore((s) => s.settings.enterKeyBehavior ?? 'send');
  const updateSettings = useSettingsStore((s) => s.updateSettings);

  const [pending, setPending] = useState<PendingChange | null>(null);

  function findConflictingId(newKey: string, exceptId: ShortcutId): ShortcutId | null {
    if (!newKey) return null;
    for (const id of SHORTCUT_IDS) {
      if (id === exceptId) continue;
      const k = getEffectiveShortcut(id, overrides);
      if (k && k.toLowerCase() === newKey.toLowerCase()) return id;
    }
    return null;
  }

  async function applyOverride(id: ShortcutId, newKey: string) {
    const next = { ...overrides, [id]: newKey };
    await updateSettings({ shortcutOverrides: next });
  }

  async function handleChange(id: ShortcutId, newKey: string) {
    if (newKey === '') {
      await applyOverride(id, '');
      return;
    }
    const conflictingId = findConflictingId(newKey, id);
    if (conflictingId) {
      setPending({ id, newKey, conflictingId });
      return;
    }
    await applyOverride(id, newKey);
  }

  async function confirmOverwrite() {
    if (!pending) return;
    const next = {
      ...overrides,
      [pending.conflictingId]: '',
      [pending.id]: pending.newKey,
    };
    await updateSettings({ shortcutOverrides: next });
    setPending(null);
  }

  async function resetOne(id: ShortcutId) {
    const next = { ...overrides };
    delete next[id];
    await updateSettings({ shortcutOverrides: next });
  }

  async function resetAll() {
    await updateSettings({ shortcutOverrides: {} });
  }

  const grouped: Record<ShortcutCategory, ShortcutId[]> = { tab: [], view: [], panel: [], input: [] };
  for (const id of SHORTCUT_IDS) grouped[SHORTCUT_REGISTRY[id].category].push(id);

  return (
    <div className="space-y-4">
      <h3 className="font-medium text-(--text-primary)">{t('settings.shortcuts')}</h3>

      <div className="space-y-2">
        <label className="block text-sm font-medium text-(--text-secondary)">
          {t('settings.enterKey.label')}
        </label>
        <select
          value={enterKeyBehavior}
          onChange={(e) => updateSettings({ enterKeyBehavior: e.target.value as EnterKeyBehavior })}
          className="w-full px-3 py-2 border border-(--input-border) rounded-md bg-(--input-bg) text-(--text-primary) focus:outline-none focus:ring-1 focus:ring-(--accent)"
        >
          <option value="send">{t('settings.enterKey.send')}</option>
          <option value="newline">{t('settings.enterKey.newline')}</option>
        </select>
      </div>

      {CATEGORY_ORDER.map((cat) => (
        <div key={cat}>
          <h4 className="text-sm text-(--text-muted) mb-2 capitalize">
            {t(`shortcut.category.${cat}`)}
          </h4>
          <div className="space-y-2">
            {grouped[cat].map((id) => {
              const def = SHORTCUT_REGISTRY[id];
              const key = getEffectiveShortcut(id, overrides);
              const conflict = isWebMode && key !== null && isBrowserConflict(key);
              return (
                <div key={id} className="flex justify-between items-center text-sm gap-2">
                  <span className="text-(--text-secondary) flex-1">{t(def.descKey)}</span>
                  {conflict && (
                    <span className="text-(--warning)" title={t('shortcut.browserConflict')}>⚠</span>
                  )}
                  <ShortcutInput
                    value={key ?? ''}
                    platform={platform}
                    onChange={(v) => handleChange(id, v)}
                  />
                  <button
                    type="button"
                    onClick={() => resetOne(id)}
                    className="text-xs text-(--text-muted) hover:text-(--text-primary) underline"
                  >
                    {t('settings.shortcutReset')}
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      ))}

      <div className="flex justify-end pt-2">
        <button
          type="button"
          onClick={resetAll}
          className="text-xs text-(--text-muted) hover:text-(--text-primary) underline"
        >
          {t('settings.shortcutResetAll')}
        </button>
      </div>

      {pending && (
        <ShortcutConflictDialog
          existingActionLabel={t(SHORTCUT_REGISTRY[pending.conflictingId].descKey)}
          formattedKey={formatShortcut(pending.newKey, platform)}
          onConfirm={confirmOverwrite}
          onCancel={() => setPending(null)}
        />
      )}
    </div>
  );
}
