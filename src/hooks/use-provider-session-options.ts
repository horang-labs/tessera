'use client';

import { useEffect, useState } from 'react';
import type { ProviderSessionOptions } from '@/lib/cli/provider-session-options';
import type { AgentEnvironment } from '@/lib/settings/types';

const cache = new Map<string, ProviderSessionOptions>();

export function invalidateProviderSessionOptionsClientCache(): void {
  cache.clear();
}

interface UseProviderSessionOptionsResult {
  data: ProviderSessionOptions | null;
  isLoading: boolean;
  error: string | null;
}

interface UseProviderSessionOptionsConfig {
  cacheKeySuffix?: string | number;
  refresh?: boolean;
}

export function useProviderSessionOptions(
  providerId?: string,
  agentEnvironment?: AgentEnvironment,
  config: UseProviderSessionOptionsConfig | string | number = {},
): UseProviderSessionOptionsResult {
  const cacheKeySuffix = typeof config === 'object'
    ? config.cacheKeySuffix ?? 0
    : config;
  const forceRefresh = typeof config === 'object' ? config.refresh === true : false;
  const cacheKey = providerId ? `${providerId}:${agentEnvironment ?? 'default'}:${cacheKeySuffix}` : null;
  const cached = cacheKey ? cache.get(cacheKey) ?? null : null;
  const [state, setState] = useState<{
    cacheKey: string | null;
    data: ProviderSessionOptions | null;
    error: string | null;
  }>({
    cacheKey,
    data: cached,
    error: null,
  });

  useEffect(() => {
    if (!providerId || !cacheKey || cached) {
      return;
    }

    let cancelled = false;
    const params = new URLSearchParams({ providerId });
    if (agentEnvironment) {
      params.set('agentEnvironment', agentEnvironment);
    }
    if (forceRefresh) {
      params.set('refresh', '1');
    }

    fetch(`/api/providers/session-options?${params.toString()}`, { cache: 'no-store' })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error('Failed to load provider session options');
        }

        return response.json() as Promise<ProviderSessionOptions>;
      })
      .then((result) => {
        if (cancelled) {
          return;
        }

        cache.set(cacheKey, result);
        setState({
          cacheKey,
          data: result,
          error: null,
        });
      })
      .catch((err: Error) => {
        if (cancelled) {
          return;
        }

        setState({
          cacheKey,
          data: null,
          error: err.message,
        });
      });

    return () => {
      cancelled = true;
    };
  }, [providerId, agentEnvironment, cacheKey, cached, forceRefresh]);

  const isCurrentState = state.cacheKey === cacheKey;
  const data = cached ?? (isCurrentState ? state.data : null);
  const error = providerId && !cached && isCurrentState ? state.error : null;
  const isLoading = Boolean(providerId && !cached && (!isCurrentState || (!state.data && !state.error)));

  return { data, isLoading, error };
}
