'use client';

import { Check } from 'lucide-react';
import { useId } from 'react';
import { useSettingsStore } from '@/stores/settings-store';
import { useI18n } from '@/lib/i18n';
import type { KanbanSessionOpenMode } from '@/lib/settings/types';
import { cn } from '@/lib/utils';
import {
  DEFAULT_FONT_SCALE,
  FONT_SCALE_OPTIONS,
  normalizeFontScale,
} from '@/lib/settings/provider-defaults';
import {
  getTerminalThemePresets,
  type TerminalThemePresetId,
  type TerminalThemePresetMode,
} from '@/lib/terminal/terminal-theme';

const PRESET_LABEL_KEYS = ['small', 'medium', 'large', 'xlarge'] as const;
const KANBAN_SESSION_OPEN_MODES: KanbanSessionOpenMode[] = ['split', 'peek'];

function KanbanSessionOpenModePicker({
  value,
  onChange,
}: {
  value: KanbanSessionOpenMode;
  onChange: (mode: KanbanSessionOpenMode) => void;
}) {
  const { t } = useI18n();
  const groupId = useId();

  return (
    <fieldset className="space-y-3 border-t border-(--divider) pt-4">
      <legend className="text-sm font-medium text-(--text-secondary)">
        {t('settings.kanbanSessionOpenMode.title')}
      </legend>
      <p className="-mt-2 text-xs leading-5 text-(--text-muted)">
        {t('settings.kanbanSessionOpenMode.description')}
      </p>
      <div className="grid gap-2 sm:grid-cols-2">
        {KANBAN_SESSION_OPEN_MODES.map((mode) => {
          const selected = value === mode;
          const inputId = `${groupId}-${mode}`;
          return (
            <label
              key={mode}
              htmlFor={inputId}
              className={cn(
                'relative flex cursor-pointer gap-3 rounded-xl border px-3 py-3 text-left transition-colors',
                'has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-(--accent)',
                selected
                  ? 'border-[color-mix(in_srgb,var(--accent)_35%,transparent)] bg-[color-mix(in_srgb,var(--accent)_10%,transparent)]'
                  : 'border-(--divider) bg-(--sidebar-bg) hover:border-(--accent)/25',
              )}
            >
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium text-(--text-primary)">
                  {t(`settings.kanbanSessionOpenMode.${mode}.label`)}
                </span>
                <span className="mt-1.5 block text-xs leading-5 text-(--text-muted)">
                  {t(`settings.kanbanSessionOpenMode.${mode}.description`)}
                </span>
              </span>
              <span className="relative mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center">
                <input
                  type="radio"
                  id={inputId}
                  name={groupId}
                  value={mode}
                  data-testid={`kanban-session-open-mode-${mode}`}
                  checked={selected}
                  onChange={() => onChange(mode)}
                  className="h-4 w-4 appearance-none rounded-full border border-(--input-border) bg-(--input-bg) checked:border-(--accent) checked:bg-(--accent)"
                />
                {selected ? (
                  <Check className="pointer-events-none absolute h-3 w-3 text-white" aria-hidden="true" />
                ) : null}
              </span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

function TerminalThemePresetPicker({
  mode,
  selectedId,
  onSelect,
}: {
  mode: TerminalThemePresetMode;
  selectedId: TerminalThemePresetId;
  onSelect: (id: TerminalThemePresetId) => void;
}) {
  const { t } = useI18n();
  const presets = getTerminalThemePresets(mode);

  return (
    <div className="space-y-2">
      <div className="text-xs font-medium text-(--text-muted)">
        {mode === 'light' ? t('settings.terminalTheme.light') : t('settings.terminalTheme.dark')}
      </div>
      <div className="grid grid-cols-2 gap-2">
        {presets.map(({ id, nameKey, theme }) => {
          const selected = id === selectedId;
          const name = t(nameKey);
          return (
            <button
              key={id}
              type="button"
              aria-pressed={selected}
              data-testid={`terminal-theme-preset-${id}`}
              onClick={() => onSelect(id)}
              className={`group min-w-0 rounded-md border p-2 text-left transition-colors focus:outline-none focus:ring-1 focus:ring-(--accent) ${
                selected
                  ? 'border-(--accent) bg-(--accent)/8'
                  : 'border-(--divider) hover:border-(--text-muted) hover:bg-(--sidebar-hover)'
              }`}
            >
              <div
                className="mb-2 flex h-11 items-end justify-between overflow-hidden rounded-sm border border-black/10 px-2 py-1.5"
                style={{ backgroundColor: theme.background, color: theme.foreground }}
                aria-hidden="true"
              >
                <span className="font-mono text-xs leading-none">›_</span>
                <span className="flex gap-1">
                  {[theme.red, theme.yellow, theme.green, theme.blue, theme.magenta].map((color) => (
                    <span
                      key={color}
                      className="h-1.5 w-1.5 rounded-full"
                      style={{ backgroundColor: color }}
                    />
                  ))}
                </span>
              </div>
              <span className="flex min-w-0 items-center justify-between gap-2">
                <span className="truncate text-xs font-medium text-(--text-secondary)">{name}</span>
                <Check
                  className={`h-3.5 w-3.5 shrink-0 text-(--accent) ${selected ? 'opacity-100' : 'opacity-0'}`}
                  aria-hidden="true"
                />
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

export default function AppearanceSettings() {
  const { t } = useI18n();
  const theme = useSettingsStore((state) => state.settings.theme);
  const terminalThemeLightPreset = useSettingsStore(
    (state) => state.settings.terminalThemeLightPreset,
  );
  const terminalThemeDarkPreset = useSettingsStore(
    (state) => state.settings.terminalThemeDarkPreset,
  );
  const fontSize = useSettingsStore((state) => state.settings.fontSize);
  const inactivePanelDimming = useSettingsStore((state) => state.settings.inactivePanelDimming);
  const showProviderIcons = useSettingsStore((state) => state.settings.showProviderIcons);
  const showRecentWork = useSettingsStore((state) => state.settings.showRecentWork);
  const kanbanSessionOpenMode = useSettingsStore(
    (state) => state.settings.kanbanSessionOpenMode,
  );
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

      <KanbanSessionOpenModePicker
        value={kanbanSessionOpenMode}
        onChange={(mode) => void updateSettings({ kanbanSessionOpenMode: mode })}
      />

      <div className="space-y-3 border-t border-(--divider) pt-4">
        <div>
          <div className="text-sm font-medium text-(--text-secondary)">
            {t('settings.terminalTheme.title')}
          </div>
          <p className="mt-1 text-xs leading-5 text-(--text-muted)">
            {t('settings.terminalTheme.description')}
          </p>
        </div>
        <TerminalThemePresetPicker
          mode="light"
          selectedId={terminalThemeLightPreset}
          onSelect={(id) => void updateSettings({
            terminalThemeLightPreset: id as typeof terminalThemeLightPreset,
          })}
        />
        <TerminalThemePresetPicker
          mode="dark"
          selectedId={terminalThemeDarkPreset}
          onSelect={(id) => void updateSettings({
            terminalThemeDarkPreset: id as typeof terminalThemeDarkPreset,
          })}
        />
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

      <label className="flex items-start gap-3 rounded-md border border-(--divider) bg-(--sidebar-bg) px-3 py-2.5">
        <input
          type="checkbox"
          checked={showRecentWork}
          onChange={(e) => updateSettings({ showRecentWork: e.target.checked })}
          className="mt-0.5 h-4 w-4 accent-(--accent)"
        />
        <span className="min-w-0">
          <span className="block text-sm font-medium text-(--text-secondary)">
            {t('settings.showRecentWork')}
          </span>
          <span className="mt-0.5 block text-xs leading-5 text-(--text-muted)">
            {t('settings.showRecentWorkDesc')}
          </span>
        </span>
      </label>
    </div>
  );
}
