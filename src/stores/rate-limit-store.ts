import { create } from 'zustand';
import type { ProviderRateLimitsSnapshot } from '@/lib/status-display/types';

interface RateLimitState {
  limitsByProvider: Record<string, ProviderRateLimitsSnapshot>;
  updateRateLimit: (snapshot: ProviderRateLimitsSnapshot) => void;
  clearRateLimit: (providerId: string) => void;
}

export const useRateLimitStore = create<RateLimitState>((set) => ({
  limitsByProvider: {},
  updateRateLimit: (snapshot) => set((state) => ({
    limitsByProvider: {
      ...state.limitsByProvider,
      [snapshot.providerId]: snapshot,
    },
  })),
  clearRateLimit: (providerId) => set((state) => {
    const next = { ...state.limitsByProvider };
    delete next[providerId];
    return { limitsByProvider: next };
  }),
}));
