import { create } from 'zustand';
import type { AppServerMessage } from '@/lib/ws/message-types';

export type TerminalSessionStatus = 'running' | 'completed' | 'input_required' | 'idle';

export interface TerminalSessionState {
  status: TerminalSessionStatus;
  hookEvent: string;
  terminalId: string;
  preview?: string;
  updatedAt: number;
  /**
   * 이 세션의 런타임이 종료됐다는 명시 신호(terminal_session_runtime running=false /
   * runtime snapshot 부재)를 받은 뒤인지. hook curl은 fire-and-forget이라 런타임이
   * 죽은 뒤에도 running/input_required가 늦게 도착할 수 있고, 이 마커가 그런 유령
   * 상태의 저장을 막는다. 세션 목록의 isRunning은 HTTP refetch 전까지 낡을 수 있어
   * 판단 기준으로 쓰지 않는다 — 같은 WS 스트림의 runtime 신호만 신뢰한다.
   */
  runtimeExited?: boolean;
}

type SessionStateMessage = Extract<AppServerMessage, { type: 'session_state' }>;

interface TerminalSessionStore {
  bySessionId: Record<string, TerminalSessionState>;
  /** Returns false when the server replayed an identical cached state. */
  applySessionState: (msg: SessionStateMessage) => boolean;
  markRuntimeStopped: (sessionId: string) => void;
  markRuntimeStarted: (sessionId: string) => void;
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

/** AskUserQuestion 카드 등 사람 입력 대기 상태 — 사이드바 노란 깜빡점의 PTY 소스. */
export function isTerminalAwaitingInput(
  state: TerminalSessionStore,
  sessionId: string,
): boolean {
  return state.bySessionId[sessionId]?.status === 'input_required';
}

export const selectIsTerminalAwaitingInput = (sessionId: string) =>
  (state: TerminalSessionStore): boolean => isTerminalAwaitingInput(state, sessionId);

// PTY hook 상태는 GUI chat-store의 turn lifecycle과 별개의 상태 머신이다.
// 터미널 패널 헤더/사이드바/보드/탭은 이 store를 processing의 SSoT로 구독한다.
export const useTerminalSessionStore = create<TerminalSessionStore>((set) => ({
  bySessionId: {},
  applySessionState: (msg) => {
    const current = useTerminalSessionStore.getState().bySessionId[msg.sessionId];
    // 종료가 확인된 런타임에는 활동 상태를 되살리지 않는다(늦은 curl 유령 방지).
    // completed/idle은 죽은 뒤에도 사실이므로 통과시킨다.
    if (
      current?.runtimeExited
      && (msg.status === 'running' || msg.status === 'input_required')
    ) {
      return false;
    }
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
          ...(current?.runtimeExited ? { runtimeExited: true } : {}),
        },
      },
    }));
    return true;
  },
  markRuntimeStopped: (sessionId) =>
    set((prev) => {
      const current = prev.bySessionId[sessionId];
      // hook 상태를 본 적 없는 세션이라도 tombstone을 남긴다 — 종료 신호보다
      // 늦게 배달되는 hook curl(running)이 첫 엔트리가 되면 꺼줄 신호가 없다.
      if (!current) {
        return {
          bySessionId: {
            ...prev.bySessionId,
            [sessionId]: {
              status: 'idle',
              hookEvent: 'RuntimeExit',
              terminalId: `session-${sessionId}`,
              updatedAt: Date.now(),
              runtimeExited: true,
            },
          },
        };
      }
      // 죽은 런타임은 입력을 받을 수 없다 — input_required를 남겨두면 답할 수 없는
      // 질문에 노란 점이 영영 깜빡인다. running과 함께 idle로 강등하고, 이후 늦게
      // 도착하는 활동 이벤트를 막기 위해 runtimeExited 마커를 남긴다.
      const demote = current.status === 'running' || current.status === 'input_required';
      if (!demote && current.runtimeExited) return prev;
      return {
        bySessionId: {
          ...prev.bySessionId,
          [sessionId]: {
            ...current,
            ...(demote ? { status: 'idle' as const, hookEvent: 'RuntimeExit' } : {}),
            runtimeExited: true,
            updatedAt: Date.now(),
          },
        },
      };
    }),
  markRuntimeStarted: (sessionId) =>
    set((prev) => {
      const current = prev.bySessionId[sessionId];
      if (!current?.runtimeExited) return prev;
      const next = { ...current, updatedAt: Date.now() };
      delete next.runtimeExited;
      return {
        bySessionId: {
          ...prev.bySessionId,
          [sessionId]: next,
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
