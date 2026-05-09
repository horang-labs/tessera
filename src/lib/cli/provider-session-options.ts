import type { PermissionMode } from '@/lib/ws/message-types';
import {
  buildClaudeSessionOptions,
  buildCodexPermissionMappings,
  buildCodexPermissionMapping,
  buildSharedPermissionMapping,
  CLAUDE_MODELS,
  CODEX_ACCESS_OPTIONS,
  OPENCODE_ACCESS_OPTIONS,
  OPENCODE_MODE_OPTIONS,
  SHARED_MODE_OPTIONS,
} from './provider-session-option-definitions';
import {
  type ProviderModelOption,
  type ProviderAccessOption,
  type ProviderModeOption,
  type ProviderPermissionMapping,
  type ProviderReasoningEffortOption,
  type ProviderSessionOptions,
} from './provider-session-option-types';
import { loadCodexSessionOptions } from './provider-session-options-codex';
import { loadOpenCodeSessionOptions } from './provider-session-options-opencode';
import { getAgentEnvironment } from './spawn-cli';
import { OPENCODE_DEFAULT_REASONING_EFFORT } from './providers/opencode/session-config';
import { SettingsManager } from '../settings/manager';
import type { AgentEnvironment } from '../settings/types';
import logger from '../logger';

const CACHE_TTL_MS = 30_000;

const cache = new Map<string, { expiresAt: number; value: ProviderSessionOptions }>();
const inflight = new Map<string, Promise<ProviderSessionOptions>>();

export type {
  ProviderModelOption,
  ProviderAccessOption,
  ProviderModeOption,
  ProviderPermissionMapping,
  ProviderReasoningEffortOption,
  ProviderSessionOptions,
} from './provider-session-option-types';

export async function getProviderSessionOptions(
  providerId: string,
  userId?: string,
  agentEnvironmentOverride?: AgentEnvironment,
): Promise<ProviderSessionOptions> {
  const agentEnvironment = await getSessionOptionsAgentEnvironment(
    providerId,
    userId,
    agentEnvironmentOverride,
  );
  const cacheKey = buildCacheKey(providerId, userId, agentEnvironment);
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  const pending = inflight.get(cacheKey);
  if (pending) {
    return pending;
  }

  const loader = loadProviderSessionOptionsWithCustomModels(providerId, userId, agentEnvironment)
    .then((value) => {
      cache.set(cacheKey, {
        value,
        expiresAt: Date.now() + CACHE_TTL_MS,
      });
      inflight.delete(cacheKey);
      return value;
    })
    .catch((error) => {
      inflight.delete(cacheKey);
      throw error;
    });

  inflight.set(cacheKey, loader);
  return loader;
}

export function mergeProviderModelOptions(
  providerId: string,
  modelOptions: ProviderModelOption[],
  customModelIds: string[] | undefined,
): ProviderModelOption[] {
  const seen = new Set(modelOptions.map((option) => option.value));
  const customOptions: ProviderModelOption[] = [];

  for (const rawModelId of customModelIds ?? []) {
    const modelId = rawModelId.trim();
    if (!modelId || seen.has(modelId)) {
      continue;
    }

    seen.add(modelId);
    customOptions.push({
      value: modelId,
      label: modelId,
      description: 'Custom model',
      isDefault: false,
      defaultReasoningEffort: getCustomModelDefaultReasoningEffort(providerId),
      supportedReasoningEfforts: getCustomModelReasoningEfforts(providerId),
    });
  }

  return [...modelOptions, ...customOptions];
}

async function loadProviderSessionOptionsWithCustomModels(
  providerId: string,
  userId?: string,
  agentEnvironment?: AgentEnvironment | 'static',
): Promise<ProviderSessionOptions> {
  const options = await loadProviderSessionOptions(providerId, userId, agentEnvironment)
    .catch((error) => {
      logger.warn({ providerId, error }, 'Provider model discovery failed; using fallback session options');
      return buildProviderSessionOptionsFallback(providerId);
    });
  if (!userId) {
    return options;
  }

  const settings = await SettingsManager.load(userId, { silent: true });
  return {
    ...options,
    modelOptions: mergeProviderModelOptions(
      providerId,
      options.modelOptions,
      settings.providerCustomModels[providerId],
    ),
  };
}

function buildProviderSessionOptionsFallback(providerId: string): ProviderSessionOptions {
  if (providerId === 'codex') {
    return {
      providerId: 'codex',
      displayName: 'Codex',
      supportsReasoningEffort: true,
      runtimeEffortChange: true,
      runtimeAccessChange: true,
      modelOptions: [],
      permissionMappings: buildCodexPermissionMappings(),
      permissionModeNote:
        'Codex maps the shared permission modes onto approvalPolicy + sandbox, so behavior is the closest available match rather than a strict 1:1 translation.',
      modeOptions: [...SHARED_MODE_OPTIONS],
      accessOptions: [...CODEX_ACCESS_OPTIONS],
      planLocksAccess: false,
    };
  }

  if (providerId === 'opencode') {
    return {
      providerId: 'opencode',
      displayName: 'OpenCode',
      supportsReasoningEffort: true,
      runtimeEffortChange: true,
      runtimeAccessChange: false,
      modelOptions: [],
      permissionMappings: [],
      modeOptions: [...OPENCODE_MODE_OPTIONS],
      accessOptions: [...OPENCODE_ACCESS_OPTIONS],
      planLocksAccess: false,
    };
  }

  return buildClaudeSessionOptions();
}

function getCustomModelDefaultReasoningEffort(providerId: string): string | null {
  if (providerId === 'claude-code') {
    return 'auto';
  }
  if (providerId === 'opencode') {
    return OPENCODE_DEFAULT_REASONING_EFFORT;
  }
  return null;
}

function getCustomModelReasoningEfforts(providerId: string): ProviderReasoningEffortOption[] {
  if (providerId === 'claude-code') {
    return CLAUDE_MODELS.find((option) => option.supportedReasoningEfforts.length > 0)
      ?.supportedReasoningEfforts ?? [];
  }
  if (providerId === 'codex') {
    return [
      { value: 'none', label: 'None', description: 'Disable extra model reasoning' },
      { value: 'minimal', label: 'Minimal', description: 'Use minimal reasoning' },
      { value: 'low', label: 'Low', description: 'Use low reasoning' },
      { value: 'medium', label: 'Medium', description: 'Use medium reasoning' },
      { value: 'high', label: 'High', description: 'Use high reasoning' },
      { value: 'xhigh', label: 'Extra High', description: 'Use extra high reasoning' },
    ];
  }
  if (providerId === 'opencode') {
    return [
      {
        value: OPENCODE_DEFAULT_REASONING_EFFORT,
        label: 'Default',
        description: 'Use the OpenCode model default',
      },
    ];
  }

  return [];
}

export function invalidateProviderSessionOptionsCache(userId?: string): void {
  if (!userId) {
    cache.clear();
    inflight.clear();
    return;
  }

  for (const key of cache.keys()) {
    if (key.split(':')[1] === userId) {
      cache.delete(key);
    }
  }

  for (const key of inflight.keys()) {
    if (key.split(':')[1] === userId) {
      inflight.delete(key);
    }
  }
}

async function getSessionOptionsAgentEnvironment(
  providerId: string,
  userId?: string,
  agentEnvironmentOverride?: AgentEnvironment,
): Promise<AgentEnvironment | 'static'> {
  if (providerId === 'codex' || providerId === 'opencode') {
    return agentEnvironmentOverride ?? getAgentEnvironment(userId);
  }

  return 'static';
}

function buildCacheKey(
  providerId: string,
  userId: string | undefined,
  agentEnvironment: AgentEnvironment | 'static',
): string {
  return `${providerId}:${userId ?? 'anonymous'}:${agentEnvironment}`;
}

async function loadProviderSessionOptions(
  providerId: string,
  userId?: string,
  agentEnvironment?: AgentEnvironment | 'static',
): Promise<ProviderSessionOptions> {
  if (providerId === 'codex') {
    return loadCodexSessionOptions(
      userId,
      agentEnvironment === 'static' ? undefined : agentEnvironment,
    );
  }

  if (providerId === 'opencode') {
    return loadOpenCodeSessionOptions(
      agentEnvironment === 'static' || !agentEnvironment ? 'native' : agentEnvironment,
    );
  }

  return buildClaudeSessionOptions();
}

export function getProviderPermissionMapping(
  providerId: string,
  permissionMode: PermissionMode,
): ProviderPermissionMapping | undefined {
  if (providerId === 'codex') {
    return buildCodexPermissionMapping(permissionMode);
  }

  return buildSharedPermissionMapping(permissionMode);
}
