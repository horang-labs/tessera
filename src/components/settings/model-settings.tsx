'use client';

import { useMemo, useState } from 'react';
import { Plus, RefreshCw, X } from 'lucide-react';
import {
  invalidateProviderSessionOptionsClientCache,
  useProviderSessionOptions,
} from '@/hooks/use-provider-session-options';
import { useSettingsStore } from '@/stores/settings-store';
import { useProvidersStore } from '@/stores/providers-store';
import { useI18n } from '@/lib/i18n';
import type { ProviderModelOption } from '@/lib/cli/provider-session-options';
import {
  buildProviderSessionDefaultsUpdate,
  normalizeProviderCustomModelList,
} from '@/lib/settings/provider-defaults';
import type { UserSettings } from '@/lib/settings/types';

const PROVIDERS = [
  { id: 'claude-code', displayName: 'Claude Code' },
  { id: 'codex', displayName: 'Codex' },
  { id: 'opencode', displayName: 'OpenCode' },
] as const;

type ProviderId = typeof PROVIDERS[number]['id'];

function getReasoningEffortValue(option: ProviderModelOption | null, current?: string | null): string {
  if (!option || option.supportedReasoningEfforts.length === 0) {
    return '';
  }
  if (current && option.supportedReasoningEfforts.some((effort) => effort.value === current)) {
    return current;
  }
  return option.defaultReasoningEffort
    ?? option.supportedReasoningEfforts[0]?.value
    ?? '';
}

function providerStatusLabel(status?: string, available?: boolean): string {
  if (status === 'connected' || available) return 'Connected';
  if (status === 'needs_login') return 'Needs login';
  return 'Not installed';
}

export default function ModelSettings() {
  const { t } = useI18n();
  const settings = useSettingsStore((state) => state.settings);
  const updateSettings = useSettingsStore((state) => state.updateSettings);
  const refreshProviders = useProvidersStore((state) => state.refresh);
  const [modelRefreshKey, setModelRefreshKey] = useState(0);

  function refreshModels() {
    invalidateProviderSessionOptionsClientCache();
    refreshProviders();
    setModelRefreshKey((key) => key + 1);
  }

  return (
    <div className="space-y-4" data-testid="model-settings">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="font-medium text-(--text-primary)">
            {t('settings.models.title')}
          </h3>
          <p className="mt-1 text-xs leading-5 text-(--text-muted)">
            {t('settings.models.description')}
          </p>
        </div>
        <button
          type="button"
          onClick={refreshModels}
          className="inline-flex h-9 items-center gap-2 rounded-md border border-(--divider) px-3 text-xs font-medium text-(--text-primary) hover:bg-(--sidebar-hover)"
        >
          <RefreshCw className="h-3.5 w-3.5" />
          <span>{t('settings.models.refresh')}</span>
        </button>
      </div>

      <div className="space-y-3">
        {PROVIDERS.map((provider) => (
          <ProviderModelSection
            key={provider.id}
            providerId={provider.id}
            displayName={provider.displayName}
            settings={settings}
            updateSettings={updateSettings}
            refreshKey={modelRefreshKey}
          />
        ))}
      </div>
    </div>
  );
}

function ProviderModelSection({
  providerId,
  displayName,
  settings,
  updateSettings,
  refreshKey,
}: {
  providerId: ProviderId;
  displayName: string;
  settings: UserSettings;
  updateSettings: (partial: Partial<UserSettings>) => Promise<void>;
  refreshKey: number;
}) {
  const { t } = useI18n();
  const agentEnvironment = useSettingsStore((state) => state.settings.agentEnvironment);
  const providers = useProvidersStore((state) => state.providers);
  const providerMeta = providers?.find((provider) => provider.id === providerId);
  const [newModelId, setNewModelId] = useState('');
  const customModels = settings.providerCustomModels[providerId] ?? [];
  const customModelVersion = customModels.join('\n');
  const { data: sessionOptions, isLoading, error } = useProviderSessionOptions(
    providerId,
    agentEnvironment,
    {
      cacheKeySuffix: `${refreshKey}:${customModelVersion}`,
      refresh: refreshKey > 0,
    },
  );
  const defaults = settings.providerDefaults[providerId] ?? {};
  const selectedModel = defaults.model ?? '';
  const selectedModelOption = sessionOptions?.modelOptions.find((option) => option.value === selectedModel) ?? null;
  const reasoningEfforts = selectedModelOption?.supportedReasoningEfforts ?? [];
  const selectedReasoningEffort = getReasoningEffortValue(selectedModelOption, defaults.reasoningEffort);
  const modelOptions = useMemo(() => sessionOptions?.modelOptions ?? [], [sessionOptions]);

  function saveCustomModels(nextModels: string[]) {
    void updateSettings({
      providerCustomModels: {
        ...settings.providerCustomModels,
        [providerId]: normalizeProviderCustomModelList(nextModels),
      },
    });
  }

  function addCustomModel() {
    const modelId = newModelId.trim();
    if (!modelId) return;
    saveCustomModels([...customModels, modelId]);
    setNewModelId('');
  }

  function removeCustomModel(modelId: string) {
    saveCustomModels(customModels.filter((candidate) => candidate !== modelId));
  }

  function selectDefaultModel(modelId: string) {
    const modelOption = modelOptions.find((option) => option.value === modelId) ?? null;
    const reasoningEffort = getReasoningEffortValue(modelOption, defaults.reasoningEffort);
    void updateSettings(buildProviderSessionDefaultsUpdate(settings, providerId, {
      model: modelId,
      reasoningEffort: reasoningEffort || null,
    }));
  }

  function selectReasoningEffort(reasoningEffort: string) {
    void updateSettings(buildProviderSessionDefaultsUpdate(settings, providerId, {
      reasoningEffort: reasoningEffort || null,
    }));
  }

  return (
    <section
      className="rounded-lg border border-(--divider) bg-(--chat-bg) p-3"
      data-testid={`model-settings-provider-${providerId}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h4 className="text-sm font-semibold text-(--text-primary)">
            {displayName}
          </h4>
          <p className="mt-1 text-xs text-(--text-muted)">
            {providerStatusLabel(providerMeta?.status, providerMeta?.available)}
          </p>
        </div>
        <div className="min-w-[14rem] flex-1 sm:max-w-sm">
          <label className="block text-xs font-medium text-(--text-secondary)">
            {t('settings.models.defaultModel')}
          </label>
          <select
            value={selectedModel}
            onChange={(event) => selectDefaultModel(event.target.value)}
            disabled={isLoading || modelOptions.length === 0}
            className="mt-1 h-9 w-full rounded-md border border-(--input-border) bg-(--input-bg) px-2 text-xs text-(--input-text) outline-none focus:border-(--accent) disabled:opacity-60"
          >
            {!selectedModel && <option value="">{t('settings.models.noDefault')}</option>}
            {modelOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
        {reasoningEfforts.length > 0 && (
          <div className="min-w-[10rem] flex-1 sm:max-w-[12rem]">
            <label className="block text-xs font-medium text-(--text-secondary)">
              {t('settings.model.reasoningEffortLabel')}
            </label>
            <select
              value={selectedReasoningEffort}
              onChange={(event) => selectReasoningEffort(event.target.value)}
              className="mt-1 h-9 w-full rounded-md border border-(--input-border) bg-(--input-bg) px-2 text-xs text-(--input-text) outline-none focus:border-(--accent)"
            >
              {reasoningEfforts.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>

      <div className="mt-3 grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(12rem,18rem)]">
        <div>
          <p className="text-xs font-medium text-(--text-secondary)">
            {t('settings.models.availableModels')}
          </p>
          <div className="mt-2 flex max-h-28 flex-wrap gap-1.5 overflow-auto">
            {isLoading && (
              <span className="text-xs text-(--text-muted)">
                {t('settings.model.loadingOptions')}
              </span>
            )}
            {error && (
              <span className="text-xs text-(--status-error-text)">
                {error}
              </span>
            )}
            {!isLoading && !error && modelOptions.map((option) => (
              <span
                key={option.value}
                className="rounded-md border border-(--divider) bg-(--input-bg) px-2 py-1 font-mono text-[11px] text-(--text-secondary)"
                title={option.description}
              >
                {option.label}
              </span>
            ))}
          </div>
        </div>

        <div>
          <p className="text-xs font-medium text-(--text-secondary)">
            {t('settings.models.customModels')}
          </p>
          <div className="mt-2 flex gap-1.5">
            <input
              value={newModelId}
              onChange={(event) => setNewModelId(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') addCustomModel();
              }}
              placeholder={t('settings.models.customModelPlaceholder')}
              className="h-9 min-w-0 flex-1 rounded-md border border-(--input-border) bg-(--input-bg) px-2.5 font-mono text-xs text-(--input-text) outline-none focus:border-(--accent)"
            />
            <button
              type="button"
              onClick={addCustomModel}
              disabled={!newModelId.trim()}
              aria-label={t('settings.models.addCustomModel')}
              title={t('settings.models.addCustomModel')}
              className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-(--input-border) text-(--text-primary) hover:bg-(--sidebar-hover) disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
            >
              <Plus className="h-3.5 w-3.5" />
            </button>
          </div>
          <div className="mt-2 space-y-1.5">
            {customModels.length === 0 && (
              <p className="text-xs text-(--text-muted)">
                {t('settings.models.noCustomModels')}
              </p>
            )}
            {customModels.map((modelId) => (
              <div
                key={modelId}
                className="flex items-center justify-between gap-2 rounded-md border border-(--divider) bg-(--input-bg) px-2 py-1.5"
              >
                <span className="min-w-0 truncate font-mono text-xs text-(--text-primary)">
                  {modelId}
                </span>
                <button
                  type="button"
                  onClick={() => removeCustomModel(modelId)}
                  aria-label={t('settings.models.removeCustomModel')}
                  title={t('settings.models.removeCustomModel')}
                  className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-(--text-muted) hover:bg-(--sidebar-hover) hover:text-(--text-primary)"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
