import { create } from 'zustand';
import type { GitPanelData } from '@/types/git';

interface GitPanelStoreState {
  /** Latest git panel data per session, populated by both REST loads and
   *  server-pushed `git_panel_state` messages. */
  dataBySessionId: Record<string, GitPanelData>;

  /** Replace the data for a session. Skipped when the payload is identical
   *  by reference. */
  applyGitPanelData: (sessionId: string, data: GitPanelData) => void;

  /** Drop a session entry (e.g. when a session is closed). */
  clearSession: (sessionId: string) => void;
}

export const useGitPanelStore = create<GitPanelStoreState>((set) => ({
  dataBySessionId: {},

  applyGitPanelData: (sessionId, data) => {
    set((state) => {
      if (state.dataBySessionId[sessionId] === data) return state;
      return {
        dataBySessionId: {
          ...state.dataBySessionId,
          [sessionId]: data,
        },
      };
    });
  },

  clearSession: (sessionId) => {
    set((state) => {
      if (!(sessionId in state.dataBySessionId)) return state;
      const { [sessionId]: _removed, ...rest } = state.dataBySessionId;
      return { dataBySessionId: rest };
    });
  },
}));
