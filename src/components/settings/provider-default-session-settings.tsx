'use client';

import { getProviderBrand } from '@/components/chat/provider-brand';
import { useProviderSessionOptions } from '@/hooks/use-provider-session-options';
import { useI18n } from '@/lib/i18n';
import {
  buildProviderSessionDefaultsUpdate,
  getProviderReasoningEffortFallback,
  resolveProviderModelOption,
  resolveProviderReasoningEffort,
} from '@/lib/settings/provider-defaults';
import { settingsTelemetryClickAttributes } from '@/lib/telemetry/ui-click';
import { useSettingsStore } from '@/stores/settings-store';

const PROVIDER_IDS = ['claude-code', 'codex', 'opencode'] as const;
const SELECT_CLASS =
  'min-w-0 flex-1 rounded-lg border border-(--divider) bg-(--input-bg) px-3 py-2 text-sm text-(--text-primary) outline-none focus:border-(--accent)/60 disabled:cursor-not-allowed disabled:opacity-50';

function ProviderDefaultSessionEditor({ providerId }: { providerId: typeof PROVIDER_IDS[number] }) {
  const { t } = useI18n();
  const settings = useSettingsStore((state) => state.settings);
  const updateSettings = useSettingsStore((state) => state.updateSettings);
  const storedDefaults = settings.providerDefaults[providerId];
  const { data: sessionOptions, isLoading, error } = useProviderSessionOptions(
    providerId,
    settings.agentEnvironment,
  );
  const selectedModel = storedDefaults?.model ?? '';
  const selectedModelOption = resolveProviderModelOption(providerId, sessionOptions, selectedModel);
  const reasoningOptions = selectedModelOption?.supportedReasoningEfforts ?? [];
  const selectedReasoningEffort = storedDefaults?.reasoningEffort ?? '';
  const hasAdvertisedModel = !selectedModel || sessionOptions?.modelOptions
    .some((option) => option.value === selectedModel);
  const hasAdvertisedReasoningEffort = !selectedReasoningEffort || reasoningOptions
    .some((option) => option.value === selectedReasoningEffort);

  const save = (patch: { model?: string; reasoningEffort?: string | null }) => {
    void updateSettings(buildProviderSessionDefaultsUpdate(
      useSettingsStore.getState().settings,
      providerId,
      patch,
    ));
  };

  const handleModelChange = (model: string) => {
    if (!model) {
      save({ model: '', reasoningEffort: null });
      return;
    }

    const modelOption = resolveProviderModelOption(providerId, sessionOptions, model);
    save({
      model,
      reasoningEffort: resolveProviderReasoningEffort(
        providerId,
        sessionOptions,
        modelOption,
        storedDefaults?.reasoningEffort ?? null,
      ) ?? getProviderReasoningEffortFallback(providerId, modelOption),
    });
  };

  return (
    <section
      className="rounded-xl border border-(--divider) bg-(--chat-bg)/55 p-3.5"
      data-testid={`provider-default-session-${providerId}`}
    >
      <h4 className="text-sm font-medium text-(--text-primary)">
        {getProviderBrand(providerId).displayName}
      </h4>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <label className="grid gap-1.5 text-xs text-(--text-muted)">
          {t('settings.model.label')}
          <select
            {...settingsTelemetryClickAttributes('settings.models.default_model')}
            value={selectedModel}
            onChange={(event) => handleModelChange(event.target.value)}
            disabled={isLoading || !sessionOptions}
            className={SELECT_CLASS}
            data-testid={`provider-default-model-${providerId}`}
          >
            <option value="">{t('settings.model.providerDefault')}</option>
            {!hasAdvertisedModel ? (
              <option value={selectedModel}>{t('settings.model.unavailableOption', { value: selectedModel })}</option>
            ) : null}
            {sessionOptions?.modelOptions.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </label>
        <label className="grid gap-1.5 text-xs text-(--text-muted)">
          {t('settings.model.reasoningEffortLabel')}
          <select
            {...settingsTelemetryClickAttributes('settings.models.default_reasoning_effort')}
            value={selectedReasoningEffort}
            onChange={(event) => save({ reasoningEffort: event.target.value || null })}
            disabled={isLoading || !sessionOptions || reasoningOptions.length === 0}
            className={SELECT_CLASS}
            data-testid={`provider-default-reasoning-effort-${providerId}`}
          >
            <option value="">{t('settings.model.providerDefault')}</option>
            {!hasAdvertisedReasoningEffort ? (
              <option value={selectedReasoningEffort}>
                {t('settings.model.unavailableOption', { value: selectedReasoningEffort })}
              </option>
            ) : null}
            {reasoningOptions.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </label>
      </div>
      {isLoading ? <p className="mt-2 text-xs text-(--text-muted)">{t('settings.model.loadingOptions')}</p> : null}
      {error ? <p className="mt-2 text-xs text-(--status-error-text)">{t('settings.model.optionsUnavailable')}</p> : null}
    </section>
  );
}

export default function ProviderDefaultSessionSettings() {
  const { t } = useI18n();

  return (
    <div>
      <h3 className="font-medium text-(--text-primary)">{t('settings.model.providerDefaultsTitle')}</h3>
      <p className="mt-1 text-xs leading-5 text-(--text-muted)">{t('settings.model.providerDefaultsHint')}</p>
      <div className="mt-4 space-y-3">
        {PROVIDER_IDS.map((providerId) => <ProviderDefaultSessionEditor key={providerId} providerId={providerId} />)}
      </div>
    </div>
  );
}
