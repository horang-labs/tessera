import { create } from 'zustand';
import type { AgentEnvironment } from '@/lib/settings/types';

interface ProviderSkillOnboardingState {
  provider: string | null;
  environment: AgentEnvironment | null;
  open(provider: string, environment: AgentEnvironment): void;
  close(): void;
}

export const useProviderSkillOnboardingStore = create<ProviderSkillOnboardingState>((set) => ({
  provider: null,
  environment: null,
  open: (provider, environment) => set({ provider, environment }),
  close: () => set({ provider: null, environment: null }),
}));
