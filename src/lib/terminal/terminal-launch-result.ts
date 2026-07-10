export const TERMINAL_LAUNCH_RESULT_EVENT = 'tessera:terminal-launch-result';

export interface TerminalLaunchResultDetail {
  terminalId: string;
  sourceSessionId: string;
  commandInput: string;
  status: 'started' | 'error';
  message?: string;
}

const queuedResults = new Map<string, TerminalLaunchResultDetail>();
const queuedResultTimers = new Map<string, ReturnType<typeof setTimeout>>();
const RESULT_TTL_MS = 5 * 60_000;

export function consumeTerminalLaunchResult(terminalId: string): void {
  queuedResults.delete(terminalId);
  const timer = queuedResultTimers.get(terminalId);
  if (timer !== undefined) clearTimeout(timer);
  queuedResultTimers.delete(terminalId);
}

export function takeTerminalLaunchResultsForSession(
  sourceSessionId: string,
): TerminalLaunchResultDetail[] {
  const results = [...queuedResults.values()]
    .filter((detail) => detail.sourceSessionId === sourceSessionId);
  for (const detail of results) {
    consumeTerminalLaunchResult(detail.terminalId);
  }
  return results;
}

export function dispatchTerminalLaunchResult(detail: TerminalLaunchResultDetail): void {
  consumeTerminalLaunchResult(detail.terminalId);
  queuedResults.set(detail.terminalId, detail);
  const timer = setTimeout(() => {
    if (queuedResults.get(detail.terminalId) !== detail) return;
    consumeTerminalLaunchResult(detail.terminalId);
  }, RESULT_TTL_MS);
  queuedResultTimers.set(detail.terminalId, timer);
  window.dispatchEvent(new CustomEvent<TerminalLaunchResultDetail>(
    TERMINAL_LAUNCH_RESULT_EVENT,
    { detail },
  ));
}
