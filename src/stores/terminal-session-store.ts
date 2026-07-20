import { create } from 'zustand';
import type { AppServerMessage } from '@/lib/ws/message-types';

export type TerminalSessionStatus = 'running' | 'completed' | 'input_required' | 'idle';

export interface TerminalSessionState {
  status: TerminalSessionStatus;
  hookEvent: string;
  terminalId: string;
  preview?: string;
  updatedAt: number;
}

type SessionStateMessage = Extract<AppServerMessage, { type: 'session_state' }>;

interface TerminalSessionStore {
  bySessionId: Record<string, TerminalSessionState>;
  /** Returns false when the server replayed an identical cached state. */
  applySessionState: (msg: SessionStateMessage) => boolean;
  markRuntimeStopped: (sessionId: string) => void;
  clearSession: (sessionId: string) => void;
}

export function isTerminalTurnProcessing(
  state: TerminalSessionStore,
  sessionId: string,
): boolean {
  return state.bySessionId[sessionId]?.status === 'running';
}

export const selectIsTerminalTurnProcessing = (sessionId: string) =>
  (state: TerminalSessionStore): boolean => isTerminalTurnProcessing(state, sessionId);

// PTY hook 상태는 GUI chat-store의 turn lifecycle과 별개의 상태 머신이다.
// 터미널 패널 헤더/사이드바/보드/탭은 이 store를 processing의 SSoT로 구독한다.
export const useTerminalSessionStore = create<TerminalSessionStore>((set) => ({
  bySessionId: {},
  applySessionState: (msg) => {
    const current = useTerminalSessionStore.getState().bySessionId[msg.sessionId];
    if (
      current
      && current.status === msg.status
      && current.hookEvent === msg.hookEvent
      && current.terminalId === msg.terminalId
      && current.preview === msg.preview
    ) {
      return false;
    }
    set((prev) => ({
      bySessionId: {
        ...prev.bySessionId,
        [msg.sessionId]: {
          status: msg.status,
          hookEvent: msg.hookEvent,
          terminalId: msg.terminalId,
          preview: msg.preview,
          updatedAt: Date.now(),
        },
      },
    }));
    return true;
  },
  markRuntimeStopped: (sessionId) =>
    set((prev) => {
      const current = prev.bySessionId[sessionId];
      if (!current || current.status !== 'running') return prev;
      return {
        bySessionId: {
          ...prev.bySessionId,
          [sessionId]: {
            ...current,
            status: 'idle',
            hookEvent: 'RuntimeExit',
            updatedAt: Date.now(),
          },
        },
      };
    }),
  clearSession: (sessionId) =>
    set((prev) => {
      if (!(sessionId in prev.bySessionId)) return prev;
      const next = { ...prev.bySessionId };
      delete next[sessionId];
      return { bySessionId: next };
    }),
}));
