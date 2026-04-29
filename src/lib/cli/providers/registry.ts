/**
 * CliProviderRegistry — Singleton registry for CLI provider implementations.
 *
 * Providers are registered by ID (e.g. "claude-code", "codex", "gemini").
 * Unknown provider IDs are treated as caller errors. Session creation paths
 * must choose a provider explicitly.
 *
 * Usage:
 *   import { cliProviderRegistry } from '@/lib/cli/providers/registry';
 *   const provider = cliProviderRegistry.getProvider('claude-code');
 */

import { spawnSync } from 'child_process';
import type { CliProvider, ProviderMeta } from './types';
import type { ProviderConnectionStatus } from './session-types';

type Environment = 'native' | 'wsl';

export class CliProviderRegistry {
  private readonly providers = new Map<string, CliProvider>();

  /**
   * Per-environment status cache. Survives the process lifetime; invalidated
   * explicitly when settings change, a spawn fails, or checkStatus returns
   * a fresh result. Never TTL-expired — users open session-creation UIs far
   * less often than every few minutes, so TTL would just force re-probes.
   */
  private readonly statusCache = new Map<Environment, ProviderMeta[]>();
  private readonly statusProbeInFlight = new Map<Environment, Promise<ProviderMeta[]>>();

  /**
   * Register a provider under the given ID.
   * Re-registering an existing ID replaces the previous implementation.
   */
  register(id: string, provider: CliProvider): void {
    this.providers.set(id, provider);
  }

  /**
   * Returns true when a provider has already been registered for the ID.
   */
  hasProvider(id: string): boolean {
    return this.providers.has(id);
  }

  /**
   * Returns the ids of all registered providers in registration order.
   * Does not perform any availability checks.
   */
  getProviderIds(): string[] {
    return Array.from(this.providers.keys());
  }

  /**
   * Register a provider only when the slot is still empty.
   * Returns the existing provider when one was already registered.
   */
  registerIfAbsent(id: string, createProvider: () => CliProvider): CliProvider {
    const existing = this.providers.get(id);
    if (existing) {
      return existing;
    }

    const provider = createProvider();
    this.providers.set(id, provider);
    return provider;
  }

  /**
   * Returns the provider for the given ID.
   * Throws when the ID is unknown so callers do not silently switch providers.
   */
  getProvider(id: string): CliProvider {
    const provider = this.providers.get(id);
    if (provider) {
      return provider;
    }

    throw new Error(`CliProviderRegistry: unknown provider id="${id}".`);
  }

  /**
   * Returns metadata for all registered providers, including availability.
   * Availability checks are delegated to each provider implementation.
   * When environment is provided, each provider probes that environment
   * (native vs. wsl) instead of the server's own host.
   */
  async listAvailable(environment?: 'native' | 'wsl'): Promise<ProviderMeta[]> {
    const results: ProviderMeta[] = [];

    for (const [id, provider] of this.providers) {
      const available = await provider.isAvailable(environment);
      results.push({
        id,
        displayName: provider.getDisplayName(),
        available,
      });
    }

    return results;
  }

  /**
   * Returns IDs of providers whose CLI binary is installed in the requested
   * environment. Delegates to listAvailable() for the iteration logic.
   */
  async detectInstalled(environment?: 'native' | 'wsl'): Promise<string[]> {
    return (await this.listAvailable(environment)).filter(p => p.available).map(p => p.id);
  }

  /**
   * Full status probe for every provider in the requested environment.
   * Uses the per-environment cache when populated; runs `checkStatus` on
   * each provider in parallel on cache miss. `available` mirrors
   * `status === 'connected'` for UI consumers that only care about
   * "fully usable".
   */
  async listStatuses(environment: Environment): Promise<ProviderMeta[]> {
    const cached = this.statusCache.get(environment);
    if (cached) {
      return cached;
    }

    return this.probeAndCacheStatuses(environment);
  }

  /**
   * Forces a fresh probe, overwriting any cached value. Callers that know
   * the prior cache is stale (e.g. after an agentEnvironment change or a
   * "Refresh" click) should use this.
   */
  async refreshStatuses(environment: Environment): Promise<ProviderMeta[]> {
    return this.probeAndCacheStatuses(environment);
  }

  /**
   * Merge an external CliStatusEntry list (e.g. from the settings-panel
   * checkCliStatus pipeline) into the cache. Settings checks are expensive
   * and users run them deliberately, so their results are always authoritative.
   */
  primeStatusCache(
    environment: Environment,
    entries: Array<{ providerId: string; status: ProviderConnectionStatus; version?: string }>,
  ): void {
    const byId = new Map(entries.map((e) => [e.providerId, e]));
    const merged: ProviderMeta[] = [];
    for (const [id, provider] of this.providers) {
      const entry = byId.get(id);
      const status = entry?.status ?? 'not_installed';
      merged.push({
        id,
        displayName: provider.getDisplayName(),
        available: status === 'connected',
        status,
        ...(entry?.version ? { version: entry.version } : {}),
      });
    }
    this.statusCache.set(environment, merged);
  }

  /**
   * Drop the cached statuses for one or all environments. Cheap — does not
   * trigger a fresh probe; the next listStatuses() will refill.
   */
  invalidateStatusCache(environment?: Environment): void {
    if (environment) {
      this.statusCache.delete(environment);
    } else {
      this.statusCache.clear();
    }
  }

  private probeAndCacheStatuses(environment: Environment): Promise<ProviderMeta[]> {
    const inFlight = this.statusProbeInFlight.get(environment);
    if (inFlight) {
      return inFlight;
    }

    const probe = this.probeStatuses(environment)
      .then((results) => {
        this.statusCache.set(environment, results);
        return results;
      })
      .finally(() => {
        if (this.statusProbeInFlight.get(environment) === probe) {
          this.statusProbeInFlight.delete(environment);
        }
      });

    this.statusProbeInFlight.set(environment, probe);
    return probe;
  }

  private async probeStatuses(environment: Environment): Promise<ProviderMeta[]> {
    const tasks = Array.from(this.providers.entries()).map(async ([id, provider]) => {
      try {
        const result = await provider.checkStatus({ environment });
        const meta: ProviderMeta = {
          id,
          displayName: provider.getDisplayName(),
          available: result.status === 'connected',
          status: result.status,
          ...(result.version ? { version: result.version } : {}),
        };
        return meta;
      } catch {
        return {
          id,
          displayName: provider.getDisplayName(),
          available: false,
          status: 'not_installed' as const,
        };
      }
    });
    return Promise.all(tasks);
  }
}

/**
 * Check whether a binary is available via `which`.
 * Uses spawnSync so it can be called from synchronous contexts.
 *
 * @param binaryName - The CLI binary name (e.g. "claude", "codex").
 * @returns true if `which <binaryName>` exits with status 0.
 */
export function isBinaryAvailable(binaryName: string): boolean {
  const result = spawnSync('which', [binaryName], { encoding: 'utf8' });
  return result.status === 0;
}

/**
 * Singleton registry instance — uses globalThis to survive Next.js hot reload
 * and webpack/tsx module boundary (API routes get a separate module scope).
 */
const REGISTRY_KEY = Symbol.for('tessera.cliProviderRegistry');
const _g = globalThis as unknown as Record<symbol, CliProviderRegistry>;

export const cliProviderRegistry: CliProviderRegistry =
  _g[REGISTRY_KEY] || (_g[REGISTRY_KEY] = new CliProviderRegistry());
