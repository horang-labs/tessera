import { create } from 'zustand';

interface SubSessionCapState {
  revealedTaskIds: Record<string, boolean>;
  isRevealed: (taskId: string) => boolean;
  toggleRevealed: (taskId: string) => void;
}

/**
 * UI-only sub-session expansion state. It intentionally outlives an individual
 * task row so switching away from and back to a Project restores its list.
 */
export const useSubSessionCapStateStore = create<SubSessionCapState>()((set, get) => ({
  revealedTaskIds: {},
  isRevealed: (taskId) => get().revealedTaskIds[taskId] ?? false,
  toggleRevealed: (taskId) => set((state) => ({
    revealedTaskIds: {
      ...state.revealedTaskIds,
      [taskId]: !(state.revealedTaskIds[taskId] ?? false),
    },
  })),
}));
