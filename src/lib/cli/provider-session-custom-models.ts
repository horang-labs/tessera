import type {
  ProviderModelOption,
  ProviderSessionOptions,
} from './provider-session-option-types';

function buildCustomModelOption(model: string): ProviderModelOption {
  return {
    value: model,
    label: model,
    isDefault: false,
    defaultReasoningEffort: null,
    supportedReasoningEfforts: [],
  };
}

export function mergeCustomModelIds(
  sessionOptions: ProviderSessionOptions,
  customModelIds: readonly string[] | null | undefined,
): ProviderSessionOptions {
  if (!customModelIds?.length) {
    return sessionOptions;
  }

  const modelOptions = [...sessionOptions.modelOptions];
  const knownModels = new Set(modelOptions.map((option) => option.value));
  for (const rawModel of customModelIds) {
    const model = rawModel.trim();
    if (!model || knownModels.has(model)) continue;
    knownModels.add(model);
    modelOptions.push(buildCustomModelOption(model));
  }

  return modelOptions.length === sessionOptions.modelOptions.length
    ? sessionOptions
    : { ...sessionOptions, modelOptions };
}
