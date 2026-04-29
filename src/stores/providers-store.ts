import { create } from 'zustand';
import { wsClient } from '@/lib/ws/client';
import { useChatStore } from '@/stores/chat-store';
import type { ProviderMeta } from '@/lib/cli/providers/types';

const PROVIDER_REQUEST_TIMEOUT_MS = 15_000;
const PROVIDER_DISPLAY_NAMES: Record<string, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
};
let providerRequestSerial = 0;

interface ProvidersState {
  /** null until the first fetch resolves. */
  providers: ProviderMeta[] | null;
  loading: boolean;
  /** Monotonic counter; increments whenever a fresh response lands. */
  version: number;

  fetch: () => void;
  refresh: () => void;
  /** Merge the CLI status result from the settings panel into this SSoT. */
  applyStatusResult: (
    entries: Array<{
      providerId: string;
      status: 'connected' | 'needs_login' | 'not_installed';
      environment: 'native' | 'wsl';
      version?: string;
    }>,
    currentEnvironment: 'native' | 'wsl',
  ) => void;
}

export const useProvidersStore = create<ProvidersState>((set, get) => ({
  providers: null,
  loading: false,
  version: 0,

  fetch: () => {
    if (get().loading) return;
    // Skip while WS is disconnected — wsClient.listProviders would immediately
    // resolve with [] and we'd flash an empty state. The ws onopen hook
    // triggers this again once connected.
    if (useChatStore.getState().connectionStatus !== 'connected') return;
    const requestSerial = ++providerRequestSerial;
    set({ loading: true });
    const timeout = setTimeout(() => {
      if (requestSerial !== providerRequestSerial) return;
      set((s) => ({
        providers: s.providers,
        loading: false,
        version: s.version + 1,
      }));
    }, PROVIDER_REQUEST_TIMEOUT_MS);
    wsClient.listProviders((received) => {
      if (requestSerial !== providerRequestSerial) return;
      clearTimeout(timeout);
      set((s) => ({
        providers: received,
        loading: false,
        version: s.version + 1,
      }));
    });
  },

  refresh: () => {
    if (useChatStore.getState().connectionStatus !== 'connected') return;
    const requestSerial = ++providerRequestSerial;
    set({ loading: true });
    const timeout = setTimeout(() => {
      if (requestSerial !== providerRequestSerial) return;
      set((s) => ({
        providers: s.providers,
        loading: false,
        version: s.version + 1,
      }));
    }, PROVIDER_REQUEST_TIMEOUT_MS);
    wsClient.refreshProviders((received) => {
      if (requestSerial !== providerRequestSerial) return;
      clearTimeout(timeout);
      set((s) => ({
        providers: received,
        loading: false,
        version: s.version + 1,
      }));
    });
  },

  applyStatusResult: (entries, currentEnvironment) => {
    // The settings panel probes every (provider × environment). Pick only
    // the rows that match the active agentEnvironment so the in-app
    // provider list reflects what the user will actually spawn.
    const byId = new Map<string, { status: 'connected' | 'needs_login' | 'not_installed'; version?: string }>();
    for (const e of entries) {
      if (e.environment !== currentEnvironment) continue;
      byId.set(e.providerId, { status: e.status, version: e.version });
    }

    const prior = get().providers ?? [];
    const merged: ProviderMeta[] = prior.map((p) => {
      const entry = byId.get(p.id);
      if (!entry) return p;
      byId.delete(p.id);
      return {
        ...p,
        status: entry.status,
        available: entry.status === 'connected',
        ...(entry.version ? { version: entry.version } : {}),
      };
    });

    for (const [providerId, entry] of byId) {
      merged.push({
        id: providerId,
        displayName: PROVIDER_DISPLAY_NAMES[providerId] ?? providerId,
        status: entry.status,
        available: entry.status === 'connected',
        ...(entry.version ? { version: entry.version } : {}),
      });
    }

    set((s) => ({ providers: merged, version: s.version + 1 }));
  },
}));
