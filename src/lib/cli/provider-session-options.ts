import type { PermissionMode } from '@/lib/ws/message-types';
import {
  buildClaudeSessionOptions,
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
import { getAgentEnvironment } from './spawn-cli';
import type { AgentEnvironment } from '../settings/types';

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
  if (providerId === 'codex') {
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
