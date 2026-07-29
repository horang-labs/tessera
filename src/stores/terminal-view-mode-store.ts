import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/**
 * Per-session rendering mode for terminal (PTY) sessions.
 *
 * 'terminal' shows the live xterm surface; 'chat' shows the same conversation
 * replayed read-only from the provider transcript. The PTY keeps running either
 * way — this only chooses which surface is on screen.
 *
 * Session-scoped rather than panel-scoped because panel-store already forbids
 * the same session being open in two panels at once.
 */
export type TerminalViewMode = 'terminal' | 'chat';

interface TerminalViewModeState {
  modeBySession: Record<string, TerminalViewMode>;
  setMode: (sessionId: string, mode: TerminalViewMode) => void;
  toggleMode: (sessionId: string) => void;
  /** Forgets a session's preference — call when the session is closed or deleted. */
  clearMode: (sessionId: string) => void;
}

export const useTerminalViewModeStore = create<TerminalViewModeState>()(
  persist(
    (set) => ({
      modeBySession: {},
      setMode: (sessionId, mode) =>
        set((state) => ({
          modeBySession: { ...state.modeBySession, [sessionId]: mode },
        })),
      toggleMode: (sessionId) =>
        set((state) => ({
          modeBySession: {
            ...state.modeBySession,
            [sessionId]: state.modeBySession[sessionId] === 'chat' ? 'terminal' : 'chat',
          },
        })),
      clearMode: (sessionId) =>
        set((state) => {
          if (!(sessionId in state.modeBySession)) return state;
          const next = { ...state.modeBySession };
          delete next[sessionId];
          return { modeBySession: next };
        }),
    }),
    { name: 'tessera:terminal-view-mode' },
  ),
);

/** Terminal sessions default to the terminal surface. */
export const selectTerminalViewMode = (sessionId: string) =>
  (state: TerminalViewModeState): TerminalViewMode =>
    state.modeBySession[sessionId] ?? 'terminal';
