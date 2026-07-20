interface SessionHeaderVisibility {
  isTerminalSession: boolean;
  isSinglePanel: boolean;
}

export function shouldShowSessionHeader({
  isTerminalSession,
  isSinglePanel,
}: SessionHeaderVisibility): boolean {
  return !isTerminalSession || !isSinglePanel;
}
