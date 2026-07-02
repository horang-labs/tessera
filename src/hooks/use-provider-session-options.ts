'use client';

import { useEffect, useState } from 'react';
import type { ProviderSessionOptions } from '@/lib/cli/provider-session-options';
import type { AgentEnvironment } from '@/lib/settings/types';

const cache = new Map<string, ProviderSessionOptions>();
const listeners = new Set<() => void>();

/**
 * Drop cached provider options (all providers, or just one) and notify mounted hooks so
 * an open composer / skill dashboard re-fetches. Called when the server broadcasts
 * `model_config_updated` after a remote model-config refresh.
 */
export function invalidateProviderSessionOptionsClientCache(providerId?: string): void {
  if (!providerId) {
    cache.clear();
  } else {
    for (const key of cache.keys()) {
      if (key.split(':')[0] === providerId) cache.delete(key);
    }
  }
  listeners.forEach((listener) => listener());
}

interface UseProviderSessionOptionsResult {
  data: ProviderSessionOptions | null;
  isLoading: boolean;
  error: string | null;
}

export function useProviderSessionOptions(
  providerId?: string,
  agentEnvironment?: AgentEnvironment,
): UseProviderSessionOptionsResult {
  const cacheKey = providerId ? `${providerId}:${agentEnvironment ?? 'default'}` : null;
  const [refreshNonce, setRefreshNonce] = useState(0);
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

  // Re-render (and re-fetch, since the cache was cleared) when options are invalidated.
  useEffect(() => {
    const listener = () => setRefreshNonce((n) => n + 1);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);

  useEffect(() => {
    if (!providerId || !cacheKey || cached) {
      return;
    }

    let cancelled = false;
    const params = new URLSearchParams({ providerId });
    if (agentEnvironment) {
      params.set('agentEnvironment', agentEnvironment);
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
  }, [providerId, agentEnvironment, cacheKey, cached, refreshNonce]);

  const isCurrentState = state.cacheKey === cacheKey;
  const data = cached ?? (isCurrentState ? state.data : null);
  const error = providerId && !cached && isCurrentState ? state.error : null;
  const isLoading = Boolean(providerId && !cached && (!isCurrentState || (!state.data && !state.error)));

  return { data, isLoading, error };
}
