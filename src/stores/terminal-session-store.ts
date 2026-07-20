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
  clearSession: (sessionId: string) => void;
}

// hook 상태를 sessionId별로 보관. chat-store/session-store를 건드리지 않아 teardown 독립.
// 터미널 패널 헤더/사이드바 배지가 이 store를 구독한다.
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
  clearSession: (sessionId) =>
    set((prev) => {
      if (!(sessionId in prev.bySessionId)) return prev;
      const next = { ...prev.bySessionId };
      delete next[sessionId];
      return { bySessionId: next };
    }),
}));
