const sessionByTerminal = new Map<string, string>();

export function markClientTerminalHandoff(terminalId: string, sessionId: string): void {
  sessionByTerminal.set(terminalId, sessionId);
}

export function clearClientTerminalHandoff(terminalId: string): void {
  sessionByTerminal.delete(terminalId);
}

export function hasClientTerminalHandoff(sessionId: string): boolean {
  return [...sessionByTerminal.values()].some((candidate) => candidate === sessionId);
}
