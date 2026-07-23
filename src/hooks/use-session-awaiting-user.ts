'use client';

import { useCallback, useMemo } from 'react';
import { hasAnyAwaitingUserPrompt, isAwaitingUserPrompt, useChatStore } from '@/stores/chat-store';
import {
  isTerminalAwaitingInput,
  selectIsTerminalAwaitingInput,
  useTerminalSessionStore,
} from '@/stores/terminal-session-store';
import { useSessionStore } from '@/stores/session-store';
import { resolveIsTerminalSession } from './use-session-processing';
import type { UnifiedSession } from '@/types/chat';

type SessionAwaitingTarget = string | Pick<UnifiedSession, 'id' | 'kind'>;

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
  const isTerminal = useSessionStore(
    (state) => resolveIsTerminalSession(
      state.getSession(sessionId)?.kind,
      fallbackKind,
    ),
  );
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
  sessions: readonly SessionAwaitingTarget[],
): boolean {
  const targetsKey = JSON.stringify(
    sessions
      .map((session) => typeof session === 'string'
        ? { id: session, kind: undefined }
        : { id: session.id, kind: session.kind })
      .sort((left, right) => left.id.localeCompare(right.id)),
  );
  const targets = useMemo(
    () => JSON.parse(targetsKey) as Array<{ id: string; kind?: UnifiedSession['kind'] }>,
    [targetsKey],
  );
  const ids = useMemo(() => targets.map((target) => target.id), [targets]);
  const fallbackKinds = useMemo(
    () => new Map(targets.map((target) => [target.id, target.kind])),
    [targets],
  );

  const terminalIdsKey = useSessionStore(useCallback(
    (state) => ids
      .filter((sessionId) => resolveIsTerminalSession(
        state.getSession(sessionId)?.kind,
        fallbackKinds.get(sessionId),
      ))
      .join(','),
    [fallbackKinds, ids],
  ));
  const terminalIds = useMemo(
    () => terminalIdsKey ? terminalIdsKey.split(',') : [],
    [terminalIdsKey],
  );
  const terminalIdSet = useMemo(() => new Set(terminalIds), [terminalIds]);
  const guiIds = useMemo(
    () => ids.filter((sessionId) => !terminalIdSet.has(sessionId)),
    [ids, terminalIdSet],
  );

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
