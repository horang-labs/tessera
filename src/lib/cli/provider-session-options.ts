import type { PermissionMode } from '@/lib/ws/message-types';
import {
  buildCodexPermissionMapping,
  buildSharedPermissionMapping,
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
import { loadClaudeSessionOptions } from './provider-session-options-claude';
import { loadOpenCodeSessionOptions } from './provider-session-options-opencode';
import { mergeCustomModelIds } from './provider-session-custom-models';
import { getAgentEnvironment } from './spawn-cli';
import type { AgentEnvironment } from '../settings/types';
import { SettingsManager } from '../settings/manager';

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

  const loader = loadProviderSessionOptions(providerId, userId, agentEnvironment)
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
  if (providerId === 'claude-code' || providerId === 'codex' || providerId === 'opencode') {
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
  let sessionOptions: ProviderSessionOptions;
  if (providerId === 'codex') {
    sessionOptions = await loadCodexSessionOptions(
      userId,
      agentEnvironment === 'static' ? undefined : agentEnvironment,
    );
  } else if (providerId === 'opencode') {
    sessionOptions = await loadOpenCodeSessionOptions(
      agentEnvironment === 'static' || !agentEnvironment ? 'native' : agentEnvironment,
    );
  } else {
    sessionOptions = await loadClaudeSessionOptions(
      agentEnvironment === 'static' || !agentEnvironment ? 'native' : agentEnvironment,
    );
  }

  if (!userId) {
    return sessionOptions;
  }

  const settings = await SettingsManager.load(userId, { silent: true });
  return mergeCustomModelIds(
    sessionOptions,
    settings.providerCustomModels[providerId],
  );
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
