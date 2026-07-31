import fs from 'fs/promises';
import path from 'path';
import type { AgentEnvironment } from '@/lib/settings/types';
import { resolveClaudeConfigDirForEnvironment } from '@/lib/skill/skill-loader';
import logger from '@/lib/logger';
import { ensureModelConfigReady } from '@/lib/model-config/remote-config';
import { buildClaudeSessionOptions } from './provider-session-option-definitions';
import type {
  ProviderModelOption,
  ProviderReasoningEffortOption,
  ProviderSessionOptions,
} from './provider-session-option-types';

const CONFIGURED_MODEL_ENV_KEYS = [
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_DEFAULT_FABLE_MODEL',
  'ANTHROPIC_CUSTOM_MODEL_OPTION',
] as const;

const MODEL_ALIAS_ENV_KEYS: Record<string, string> = {
  opus: 'ANTHROPIC_DEFAULT_OPUS_MODEL',
  sonnet: 'ANTHROPIC_DEFAULT_SONNET_MODEL',
  haiku: 'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  fable: 'ANTHROPIC_DEFAULT_FABLE_MODEL',
};

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function toStringMap(value: unknown): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(toRecord(value))) {
    if (typeof entry === 'string') {
      result[key] = entry;
    }
  }
  return result;
}

function readTrimmed(env: Record<string, string>, key: string): string {
  return env[key]?.trim() ?? '';
}

function buildConfiguredReasoningEfforts(rawCapabilities: string): ProviderReasoningEffortOption[] {
  const capabilities = new Set(
    rawCapabilities
      .split(',')
      .map((capability) => capability.trim().toLowerCase())
      .filter(Boolean),
  );
  const supportsBaseEffort = capabilities.has('effort');
  const supportsXHighEffort = capabilities.has('xhigh_effort');
  const supportsMaxEffort = capabilities.has('max_effort');

  if (!supportsBaseEffort && !supportsXHighEffort && !supportsMaxEffort) {
    return [];
  }

  const efforts: ProviderReasoningEffortOption[] = [
    {
      value: 'auto',
      label: 'Auto',
      description: 'Use the CLI default',
    },
  ];

  if (supportsBaseEffort) {
    efforts.push(
      { value: 'low', label: 'Low', description: 'Faster responses with less thinking' },
      { value: 'medium', label: 'Medium', description: 'Balanced thinking and speed' },
      { value: 'high', label: 'High', description: 'Deeper reasoning' },
    );
  }
  if (supportsXHighEffort) {
    efforts.push({
      value: 'xhigh',
      label: 'Extra High',
      description: 'Deeper reasoning, just below maximum',
    });
  }
  if (supportsMaxEffort) {
    efforts.push({
      value: 'max',
      label: 'Max',
      description: 'Maximum reasoning depth',
      requiresRestart: true,
    });
  }

  return efforts;
}

function upsertConfiguredModel(
  models: ProviderModelOption[],
  env: Record<string, string>,
  modelEnvKey: string,
): void {
  const modelId = readTrimmed(env, modelEnvKey);
  if (!modelId) return;

  const index = models.findIndex((model) => model.value === modelId);
  const existing = index >= 0 ? models[index] : undefined;
  const name = readTrimmed(env, `${modelEnvKey}_NAME`);
  const description = readTrimmed(env, `${modelEnvKey}_DESCRIPTION`);
  const capabilitiesKey = `${modelEnvKey}_SUPPORTED_CAPABILITIES`;
  const hasConfiguredCapabilities = Object.prototype.hasOwnProperty.call(env, capabilitiesKey);
  const supportedReasoningEfforts = hasConfiguredCapabilities
    ? buildConfiguredReasoningEfforts(env[capabilitiesKey])
    : existing?.supportedReasoningEfforts ?? [];

  const option: ProviderModelOption = {
    ...existing,
    value: modelId,
    label: name || existing?.label || modelId,
    isDefault: existing?.isDefault ?? false,
    defaultReasoningEffort: hasConfiguredCapabilities
      ? (supportedReasoningEfforts.length > 0 ? 'auto' : null)
      : existing?.defaultReasoningEffort ?? null,
    supportedReasoningEfforts,
  };
  if (description) {
    option.description = description;
  }

  if (index >= 0) {
    models[index] = option;
  } else {
    models.push(option);
  }
}

function resolveModelAlias(model: string, env: Record<string, string>): string {
  const aliasEnvKey = MODEL_ALIAS_ENV_KEYS[model.toLowerCase()];
  return aliasEnvKey ? readTrimmed(env, aliasEnvKey) || model : model;
}

function upsertDefaultModel(models: ProviderModelOption[], modelId: string): void {
  const index = models.findIndex((model) => model.value === modelId);
  if (index < 0) {
    models.push({
      value: modelId,
      label: modelId,
      isDefault: true,
      defaultReasoningEffort: null,
      supportedReasoningEfforts: [],
    });
  }

  for (let modelIndex = 0; modelIndex < models.length; modelIndex += 1) {
    const model = models[modelIndex];
    const isDefault = model.value === modelId;
    if (model.isDefault !== isDefault) {
      models[modelIndex] = { ...model, isDefault };
    }
  }
}

/**
 * Merge the model aliases that Claude Code reads from its active settings file.
 * Capability controls stay conservative: only an explicit CLI capability list
 * creates effort options, and no config value is interpreted as Fast support.
 */
export function mergeClaudeConfiguredModels(
  baseModels: readonly ProviderModelOption[],
  rawSettings: unknown,
  runtimeEnv: Record<string, string | undefined> = process.env,
): ProviderModelOption[] {
  const settings = toRecord(rawSettings);
  const env = {
    ...toStringMap(runtimeEnv),
    ...toStringMap(settings.env),
  };
  const models = baseModels.map((model) => ({
    ...model,
    supportedReasoningEfforts: [...model.supportedReasoningEfforts],
    ...(model.serviceTiers && { serviceTiers: [...model.serviceTiers] }),
  }));

  for (const modelEnvKey of CONFIGURED_MODEL_ENV_KEYS) {
    upsertConfiguredModel(models, env, modelEnvKey);
  }

  const configuredDefault = readTrimmed(env, 'ANTHROPIC_MODEL')
    || (typeof settings.model === 'string' ? settings.model.trim() : '');
  if (configuredDefault) {
    upsertDefaultModel(models, resolveModelAlias(configuredDefault, env));
  }

  return models;
}

async function readClaudeSettings(agentEnvironment: AgentEnvironment): Promise<unknown> {
  const configDir = await resolveClaudeConfigDirForEnvironment(agentEnvironment);
  const settingsPath = path.join(configDir, 'settings.json');
  try {
    return JSON.parse(await fs.readFile(settingsPath, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      logger.warn({ error, settingsPath }, 'Failed to read Claude Code settings for model options');
    }
    return {};
  }
}

export async function loadClaudeSessionOptions(
  agentEnvironment: AgentEnvironment = 'native',
): Promise<ProviderSessionOptions> {
  await ensureModelConfigReady();
  const [baseOptions, settings] = await Promise.all([
    Promise.resolve(buildClaudeSessionOptions()),
    readClaudeSettings(agentEnvironment),
  ]);

  return {
    ...baseOptions,
    modelOptions: mergeClaudeConfiguredModels(baseOptions.modelOptions, settings),
  };
}
