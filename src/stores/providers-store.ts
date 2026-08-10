import { create } from 'zustand';
import { wsClient } from '@/lib/ws/client';
import { useChatStore } from '@/stores/chat-store';
import type { ProviderMeta } from '@/lib/cli/providers/types';

const PROVIDER_REQUEST_TIMEOUT_MS = 2_000;
const PROVIDER_REQUEST_RETRY_COUNT = 3;
let providerRequestSerial = 0;
let cancelActiveProviderRequest: (() => void) | null = null;

interface ProvidersState {
  /** null until the first provider response arrives. */
  providers: ProviderMeta[] | null;
  /** True once the first provider request has completed or timed out. */
  initialized: boolean;
  loading: boolean;
  /** Monotonic counter; increments whenever a fresh response lands. */
  version: number;

  fetch: () => void;
  refresh: () => void;
}

export const useProvidersStore = create<ProvidersState>((set, get) => {
  const runProviderRequest = (
    sendRequest: (
      callback: (providers: ProviderMeta[] | null) => void,
    ) => (() => void) | void,
  ) => {
    // Skip while WS is disconnected — provider WS requests would immediately
    // resolve with [] and we'd flash an empty state. The ws onopen hook
    // triggers this again once connected.
    if (useChatStore.getState().connectionStatus !== 'connected') return;

    cancelActiveProviderRequest?.();
    cancelActiveProviderRequest = null;

    const requestSerial = ++providerRequestSerial;
    let attempt = 0;
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    let cancelAttempt: (() => void) | null = null;

    const cancelCurrentRequest = () => {
      settled = true;
      if (timeout) {
        clearTimeout(timeout);
        timeout = null;
      }
      cancelAttempt?.();
      cancelAttempt = null;
    };

    const finish = (received?: ProviderMeta[]) => {
      if (settled || requestSerial !== providerRequestSerial) return;
      cancelCurrentRequest();
      if (cancelActiveProviderRequest === cancelCurrentRequest) {
        cancelActiveProviderRequest = null;
      }
      set((s) => ({
        providers: received === undefined ? s.providers : received,
        initialized: true,
        loading: false,
        version: s.version + 1,
      }));
    };

    const sendAttempt = () => {
      attempt += 1;
      timeout = setTimeout(() => {
        if (settled || requestSerial !== providerRequestSerial) return;
        if (attempt <= PROVIDER_REQUEST_RETRY_COUNT) {
          cancelAttempt?.();
          cancelAttempt = null;
          sendAttempt();
          return;
        }
        finish();
      }, PROVIDER_REQUEST_TIMEOUT_MS);

      cancelAttempt = sendRequest((received) => finish(received ?? undefined)) ?? null;
    };

    cancelActiveProviderRequest = cancelCurrentRequest;
    set({ loading: true });
    sendAttempt();
  };

  return {
    providers: null,
    initialized: false,
    loading: false,
    version: 0,

    fetch: () => {
      if (get().loading) return;
      runProviderRequest(wsClient.listProviders.bind(wsClient));
    },

    refresh: () => {
      runProviderRequest(wsClient.refreshProviders.bind(wsClient));
    },

  };
});
