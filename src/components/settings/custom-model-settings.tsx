'use client';

import { useState, type FormEvent } from 'react';
import { Trash2 } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { useSettingsStore } from '@/stores/settings-store';

const CUSTOM_MODEL_PROVIDERS = [
  { id: 'claude-code', label: 'Claude Code' },
  { id: 'codex', label: 'Codex' },
] as const;

interface ProviderCustomModelEditorProps {
  providerId: string;
  providerLabel: string;
  models: readonly string[];
  onAdd: (providerId: string, model: string) => void;
  onRemove: (providerId: string, model: string) => void;
}

function ProviderCustomModelEditor({
  providerId,
  providerLabel,
  models,
  onAdd,
  onRemove,
}: ProviderCustomModelEditorProps) {
  const { t } = useI18n();
  const [draft, setDraft] = useState('');
  const normalizedDraft = draft.trim();
  const canAdd = normalizedDraft.length > 0 && !models.includes(normalizedDraft);

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canAdd) return;
    onAdd(providerId, normalizedDraft);
    setDraft('');
  };

  return (
    <div
      className="rounded-xl border border-(--divider) bg-(--chat-bg)/55 p-3.5"
      data-testid={`custom-model-provider-${providerId}`}
    >
      <label
        htmlFor={`custom-model-${providerId}`}
        className="text-sm font-medium text-(--text-primary)"
      >
        {providerLabel}
      </label>
      <form className="mt-2 flex gap-2" onSubmit={handleSubmit}>
        <input
          id={`custom-model-${providerId}`}
          type="text"
          value={draft}
          spellCheck={false}
          autoComplete="off"
          placeholder={t('settings.model.customPlaceholder')}
          onChange={(event) => setDraft(event.target.value)}
          className="h-10 min-w-0 flex-1 rounded-lg border border-(--divider) bg-(--input-bg) px-3 font-mono text-sm text-(--text-primary) outline-none transition-colors placeholder:text-(--text-muted) focus:border-(--accent)/60"
          data-testid={`custom-model-input-${providerId}`}
        />
        <button
          type="submit"
          disabled={!canAdd}
          className="h-10 shrink-0 rounded-lg border border-(--divider) px-4 text-sm font-medium text-(--text-secondary) transition-colors hover:border-(--accent)/40 hover:bg-(--sidebar-hover) hover:text-(--text-primary) disabled:cursor-not-allowed disabled:opacity-45"
          data-testid={`custom-model-add-${providerId}`}
        >
          {t('settings.model.customApply')}
        </button>
      </form>

      {models.length > 0 ? (
        <ul className="mt-3 space-y-1.5">
          {models.map((model) => (
            <li
              key={model}
              className="flex items-center gap-2 rounded-lg bg-(--input-bg)/75 py-1.5 pl-3 pr-1.5"
            >
              <code className="min-w-0 flex-1 break-all text-xs text-(--text-secondary)">
                {model}
              </code>
              <button
                type="button"
                onClick={() => onRemove(providerId, model)}
                aria-label={`${t('settings.model.customRemove')}: ${model}`}
                title={`${t('settings.model.customRemove')}: ${model}`}
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-(--text-muted) transition-colors hover:bg-(--status-error-bg) hover:text-(--status-error-text)"
                data-testid={`custom-model-remove-${providerId}`}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-3 text-xs text-(--text-muted)">
          {t('settings.model.customEmpty')}
        </p>
      )}
    </div>
  );
}

export default function CustomModelSettings() {
  const { t } = useI18n();
  const customModels = useSettingsStore((state) => state.settings.providerCustomModels);
  const updateSettings = useSettingsStore((state) => state.updateSettings);

  const addModel = (providerId: string, model: string) => {
    const current = useSettingsStore.getState().settings.providerCustomModels;
    const providerModels = current[providerId] ?? [];
    if (providerModels.includes(model)) return;
    void updateSettings({
      providerCustomModels: {
        ...current,
        [providerId]: [...providerModels, model],
      },
    });
  };

  const removeModel = (providerId: string, model: string) => {
    const current = useSettingsStore.getState().settings.providerCustomModels;
    const nextProviderModels = (current[providerId] ?? []).filter((entry) => entry !== model);
    const next = { ...current };
    if (nextProviderModels.length > 0) {
      next[providerId] = nextProviderModels;
    } else {
      delete next[providerId];
    }
    void updateSettings({ providerCustomModels: next });
  };

  return (
    <div>
      <h3 className="font-medium text-(--text-primary)">
        {t('settings.model.customLabel')}
      </h3>
      <p className="mt-1 text-xs leading-5 text-(--text-muted)">
        {t('settings.model.customHint')}
      </p>
      <div className="mt-4 space-y-3">
        {CUSTOM_MODEL_PROVIDERS.map((provider) => (
          <ProviderCustomModelEditor
            key={provider.id}
            providerId={provider.id}
            providerLabel={provider.label}
            models={customModels[provider.id] ?? []}
            onAdd={addModel}
            onRemove={removeModel}
          />
        ))}
      </div>
    </div>
  );
}
