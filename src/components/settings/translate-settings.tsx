'use client';

import { useSettingsStore } from '@/stores/settings-store';
import { useI18n } from '@/lib/i18n';
import { useProviderSessionOptions } from '@/hooks/use-provider-session-options';
import { DEFAULT_TRANSLATE_PROMPT_TEMPLATE } from '@/lib/session/translate-prompt';
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

type Direction = {
  provider: string;
  model?: string;
};

function TranslateDirectionSettings({
  sectionTitle,
  value,
  onChangeProvider,
  onChangeModel,
}: {
  sectionTitle: string;
  value: Direction;
  onChangeProvider: (provider: string) => void;
  onChangeModel: (model: string) => void;
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
        <label htmlFor="translateEnabled" className="text-sm text-(--text-secondary)">
          {t('settings.translate.enabled')}
        </label>
        <input
          type="checkbox"
          id="translateEnabled"
          checked={translate.enabled}
          onChange={(e) =>
            updateSettings({ translate: { ...translate, enabled: e.target.checked } })
          }
          className="w-4 h-4 accent-(--accent)"
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
      />

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <label className="block text-sm font-medium text-(--text-secondary)">
            {t('settings.translate.promptLabel')}
          </label>
          <button
            type="button"
            onClick={() =>
              updateSettings({
                translate: { ...translate, promptTemplate: DEFAULT_TRANSLATE_PROMPT_TEMPLATE },
              })
            }
            className="text-[11px] text-(--accent) hover:underline"
          >
            {t('settings.translate.promptReset')}
          </button>
        </div>
        <textarea
          value={translate.promptTemplate}
          onChange={(e) =>
            updateSettings({ translate: { ...translate, promptTemplate: e.target.value } })
          }
          placeholder={DEFAULT_TRANSLATE_PROMPT_TEMPLATE}
          rows={10}
          className="w-full px-3 py-2 border border-(--input-border) rounded-md bg-(--input-bg) text-(--text-primary) text-[12px] font-mono leading-relaxed resize-y focus:outline-none focus:ring-1 focus:ring-(--accent)"
        />
        <p className="text-[11px] text-(--text-tertiary)">{t('settings.translate.promptHint')}</p>
      </div>
    </div>
  );
}
