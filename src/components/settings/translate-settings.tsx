'use client';

import { useState } from 'react';
import { useSettingsStore } from '@/stores/settings-store';
import { useI18n } from '@/lib/i18n';
import { useProviderSessionOptions } from '@/hooks/use-provider-session-options';
import { DEFAULT_TRANSLATE_PROMPT_TEMPLATE } from '@/lib/session/translate-prompt';
import { eventToShortcut, formatShortcut } from '@/lib/keyboard-shortcut';
import type { Language } from '@/lib/settings/types';

const LANGUAGE_OPTIONS: { value: Language; label: string }[] = [
  { value: 'en', label: 'English' },
  { value: 'ko', label: '한국어' },
  { value: 'ja', label: '日本語' },
  { value: 'zh', label: '中文' },
];

const PROVIDER_OPTIONS = ['claude-code', 'codex', 'opencode'] as const;

const SELECT_CLASS =
  'w-full px-3 py-2 border border-(--input-border) rounded-md bg-(--input-bg) text-(--text-primary) focus:outline-none focus:ring-1 focus:ring-(--accent) disabled:opacity-50 disabled:cursor-not-allowed';

const TEXTAREA_CLASS =
  'w-full px-3 py-2 border border-(--input-border) rounded-md bg-(--input-bg) text-(--text-primary) text-[12px] font-mono leading-relaxed resize-y focus:outline-none focus:ring-1 focus:ring-(--accent)';

type Direction = {
  provider: string;
  model?: string;
  promptTemplate?: string;
};

/** A small on/off switch. */
function Toggle({ checked, onChange }: { checked: boolean; onChange: (next: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${
        checked ? 'bg-(--accent)' : 'bg-(--divider)'
      }`}
    >
      <span
        className={`inline-block h-4 w-4 rounded-full bg-white shadow transition-transform ${
          checked ? 'translate-x-4' : 'translate-x-0.5'
        }`}
      />
    </button>
  );
}

/** Click then press a key combo to record a shortcut. */
function ShortcutRecorder({ value, onChange }: { value: string; onChange: (next: string) => void }) {
  const { t } = useI18n();
  const [recording, setRecording] = useState(false);

  return (
    <button
      type="button"
      onClick={() => setRecording(true)}
      onBlur={() => setRecording(false)}
      onKeyDown={(e) => {
        if (!recording) return;
        if (e.key === 'Escape') {
          setRecording(false);
          return;
        }
        e.preventDefault();
        const sc = eventToShortcut(e);
        if (sc) {
          onChange(sc);
          setRecording(false);
        }
      }}
      className={`${SELECT_CLASS} text-left font-mono ${recording ? 'ring-1 ring-(--accent)' : ''}`}
    >
      {recording ? t('settings.translate.shortcutRecording') : formatShortcut(value) || '—'}
    </button>
  );
}

function TranslateDirectionSettings({
  sectionTitle,
  value,
  onChangeProvider,
  onChangeModel,
  onChangePrompt,
}: {
  sectionTitle: string;
  value: Direction;
  onChangeProvider: (provider: string) => void;
  onChangeModel: (model: string) => void;
  onChangePrompt: (prompt: string) => void;
}) {
  const { t } = useI18n();
  const cliCommandOverrides = useSettingsStore((state) => state.settings.cliCommandOverrides);
  const { data } = useProviderSessionOptions(value.provider);

  const isOpencode = value.provider === 'opencode';
  const modelOptions = data?.modelOptions ?? [];
  const hasCliCommand = Boolean(cliCommandOverrides?.[value.provider]);

  return (
    <div className="space-y-3 rounded-md border border-(--divider) bg-(--sidebar-bg) px-3 py-3">
      <h4 className="text-sm font-medium text-(--text-primary)">{sectionTitle}</h4>

      <div className="space-y-2">
        <label className="block text-sm font-medium text-(--text-secondary)">
          {t('settings.translate.provider')}
        </label>
        <select
          value={value.provider}
          onChange={(e) => onChangeProvider(e.target.value)}
          className={SELECT_CLASS}
        >
          {PROVIDER_OPTIONS.map((provider) => (
            <option key={provider} value={provider}>
              {provider}
            </option>
          ))}
        </select>
        {!hasCliCommand && (
          <p className="text-[11px] text-(--text-tertiary)">
            {t('settings.translate.noCliCommandWarning')}
          </p>
        )}
      </div>

      <div className="space-y-2">
        <label className="block text-sm font-medium text-(--text-secondary)">
          {t('settings.translate.model')}
        </label>
        <select
          value={value.model ?? ''}
          onChange={(e) => onChangeModel(e.target.value)}
          disabled={isOpencode}
          className={SELECT_CLASS}
        >
          <option value="">{t('settings.translate.modelDefault')}</option>
          {modelOptions.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        {isOpencode && (
          <p className="text-[11px] text-(--text-tertiary)">
            {t('settings.translate.opencodeModelNote')}
          </p>
        )}
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <label className="block text-sm font-medium text-(--text-secondary)">
            {t('settings.translate.promptLabel')}
          </label>
          <button
            type="button"
            onClick={() => onChangePrompt(DEFAULT_TRANSLATE_PROMPT_TEMPLATE)}
            className="text-[11px] text-(--accent) hover:underline"
          >
            {t('settings.translate.promptReset')}
          </button>
        </div>
        <textarea
          value={value.promptTemplate || DEFAULT_TRANSLATE_PROMPT_TEMPLATE}
          onChange={(e) => onChangePrompt(e.target.value)}
          rows={10}
          className={TEXTAREA_CLASS}
        />
        <p className="text-[11px] text-(--text-tertiary)">{t('settings.translate.promptHint')}</p>
      </div>
    </div>
  );
}

export default function TranslateSettings() {
  const { t } = useI18n();
  const translate = useSettingsStore((state) => state.settings.translate);
  const updateSettings = useSettingsStore((state) => state.updateSettings);

  return (
    <div className="space-y-4">
      <h3 className="font-medium text-(--text-primary)">{t('settings.translate.title')}</h3>

      <div className="flex items-center justify-between">
        <label className="text-sm text-(--text-secondary)">
          {t('settings.translate.enabled')}
        </label>
        <Toggle
          checked={translate.enabled}
          onChange={(next) => updateSettings({ translate: { ...translate, enabled: next } })}
        />
      </div>

      <div className="space-y-2">
        <label className="block text-sm font-medium text-(--text-secondary)">
          {t('settings.translate.sourceLanguage')}
        </label>
        <select
          value={translate.sourceLanguage}
          onChange={(e) =>
            updateSettings({
              translate: { ...translate, sourceLanguage: e.target.value as Language },
            })
          }
          className={SELECT_CLASS}
        >
          {LANGUAGE_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>

      <div className="space-y-2">
        <label className="block text-sm font-medium text-(--text-secondary)">
          {t('settings.translate.targetLanguage')}
        </label>
        <select
          value={translate.targetLanguage}
          onChange={(e) =>
            updateSettings({
              translate: { ...translate, targetLanguage: e.target.value as Language },
            })
          }
          className={SELECT_CLASS}
        >
          {LANGUAGE_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>

      <div className="space-y-2">
        <label className="block text-sm font-medium text-(--text-secondary)">
          {t('settings.translate.sendShortcut')}
        </label>
        <ShortcutRecorder
          value={translate.sendShortcut}
          onChange={(next) => updateSettings({ translate: { ...translate, sendShortcut: next } })}
        />
        <p className="text-[11px] text-(--text-tertiary)">{t('settings.translate.sendShortcutHint')}</p>
      </div>

      <TranslateDirectionSettings
        sectionTitle={t('settings.translate.inputSection')}
        value={translate.input}
        onChangeProvider={(provider) =>
          updateSettings({
            translate: { ...translate, input: { ...translate.input, provider } },
          })
        }
        onChangeModel={(model) =>
          updateSettings({
            translate: {
              ...translate,
              input: { ...translate.input, model: model || undefined },
            },
          })
        }
        onChangePrompt={(promptTemplate) =>
          updateSettings({
            translate: { ...translate, input: { ...translate.input, promptTemplate } },
          })
        }
      />

      <TranslateDirectionSettings
        sectionTitle={t('settings.translate.outputSection')}
        value={translate.output}
        onChangeProvider={(provider) =>
          updateSettings({
            translate: { ...translate, output: { ...translate.output, provider } },
          })
        }
        onChangeModel={(model) =>
          updateSettings({
            translate: {
              ...translate,
              output: { ...translate.output, model: model || undefined },
            },
          })
        }
        onChangePrompt={(promptTemplate) =>
          updateSettings({
            translate: { ...translate, output: { ...translate.output, promptTemplate } },
          })
        }
      />
    </div>
  );
}
