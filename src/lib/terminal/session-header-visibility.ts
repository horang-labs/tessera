interface SessionHeaderVisibility {
  isTerminalSession: boolean;
  isSinglePanel: boolean;
  /** 이 세션에 터미널⇄채팅 토글이 붙는지(= 헤더가 담아야 할 컨트롤이 있는지). */
  canToggleTerminalChatView?: boolean;
}

export function shouldShowSessionHeader({
  isTerminalSession,
  isSinglePanel,
  canToggleTerminalChatView = false,
}: SessionHeaderVisibility): boolean {
  // 단일 패널 터미널은 탭 제목과 중복되는 헤더를 숨겨 xterm에 화면을 다 내준다.
  // 단, 터미널⇄채팅 토글이 붙는 세션은 예외 — 헤더가 그 토글의 유일한 자리라,
  // 숨기면 채팅으로 넘어갈 방법도 돌아올 방법도 화면에서 사라진다.
  if (canToggleTerminalChatView) return true;
  return !isTerminalSession || !isSinglePanel;
}
