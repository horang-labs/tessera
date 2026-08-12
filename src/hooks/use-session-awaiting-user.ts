'use client';

import { useCallback } from 'react';
import { hasAnyAwaitingUserPrompt, isAwaitingUserPrompt, useChatStore } from '@/stores/chat-store';
import {
  isTerminalAwaitingInput,
  selectIsTerminalAwaitingInput,
  useTerminalSessionStore,
} from '@/stores/terminal-session-store';
import { useProjectViewSession } from '@/hooks/use-project-view-workspace-state';
import {
  resolveIsTerminalSession,
  useSessionKindGroups,
  type SessionKindTarget,
} from './use-session-kind-groups';
import type { UnifiedSession } from '@/types/chat';

/**
 * "사용자 입력 대기"(노란 깜빡점) 판정을 GUI/PTY lifecycle을 섞지 않고 합성한다.
 * GUI 세션은 기존 chat-store activeInteractivePrompt만, PTY 세션은
 * terminal-session-store의 input_required만 읽는다 — use-session-processing과
 * 같은 분기 구조라 챗 GUI 모드의 데이터 흐름에는 어떤 영향도 없다.
 */
export function useIsSessionAwaitingUser(
  sessionId: string,
  fallbackKind?: UnifiedSession['kind'],
): boolean {
  const session = useProjectViewSession(sessionId);
  const isTerminal = resolveIsTerminalSession(session?.kind, fallbackKind);
  const guiAwaiting = useChatStore(
    useCallback(
      (state) => !isTerminal && isAwaitingUserPrompt(state, sessionId),
      [isTerminal, sessionId],
    ),
  );
  const terminalAwaiting = useTerminalSessionStore(selectIsTerminalAwaitingInput(sessionId));
  return isTerminal ? terminalAwaiting : guiAwaiting;
}

/** 여러 세션 중 하나라도 입력 대기인지 — 탭/컬렉션/칸반 집계용. */
export function useAnySessionAwaitingUser(
  sessions: readonly SessionKindTarget[],
): boolean {
  const { guiIds, terminalIds } = useSessionKindGroups(sessions);

  const hasGuiAwaiting = useChatStore(useCallback(
    (state) => hasAnyAwaitingUserPrompt(state, guiIds),
    [guiIds],
  ));
  const hasTerminalAwaiting = useTerminalSessionStore(useCallback(
    (state) => terminalIds.some((sessionId) => isTerminalAwaitingInput(state, sessionId)),
    [terminalIds],
  ));

  return hasGuiAwaiting || hasTerminalAwaiting;
}
