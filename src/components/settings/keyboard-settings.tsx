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
  const visibleShortcutIds = isWebMode
    ? SHORTCUT_IDS
    : SHORTCUT_IDS.filter((id) => id !== 'voice-input');

  function findConflictingId(newKey: string, exceptId: ShortcutId): ShortcutId | null {
    if (!newKey) return null;
    for (const id of visibleShortcutIds) {
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
  for (const id of visibleShortcutIds) grouped[SHORTCUT_REGISTRY[id].category].push(id);

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

      {CATEGORY_ORDER.filter((cat) => grouped[cat].length > 0).map((cat) => (
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
                // `flex-wrap`: the description shrinks to its longest word and the two
                // controls do not shrink at all — a chord like Ctrl+Alt+Shift+← and the
                // Reset beside it are each one unbreakable token. At 360px and font scale
                // 1.375 the card is 203px wide and those three want 293px, so on a single
                // line the Reset ran to x=375 — past the 360px screen, not just past the
                // card (#268). Wrapping spends height, which the card has, instead of
                // width, which it does not.
                <div
                  key={id}
                  className="flex flex-wrap justify-between items-center text-sm gap-2"
                  data-testid={`shortcut-row-${id}`}
                >
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
                    // `ml-auto` only bites on a wrapped line: when the row fits on one
                    // line the description's `flex-1` has already eaten the free space, so
                    // this is a no-op there. When Reset is pushed onto its own line it
                    // keeps it under the chord it resets rather than under the label.
                    className="ml-auto text-xs text-(--text-muted) hover:text-(--text-primary) underline"
                    data-testid={`shortcut-reset-${id}`}
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
