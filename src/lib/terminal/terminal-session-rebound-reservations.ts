export interface PendingTerminalRebound {
  destinationSessionId: string;
  sourceSessionIds: Set<string>;
}

const pendingTerminalRebounds = new Map<string, PendingTerminalRebound>();

export function recordPendingTerminalRebound(
  terminalId: string,
  previousSessionId: string,
  destinationSessionId: string,
): PendingTerminalRebound {
  const pending = pendingTerminalRebounds.get(terminalId) ?? {
    destinationSessionId,
    sourceSessionIds: new Set<string>(),
  };
  pending.sourceSessionIds.add(previousSessionId);
  pending.destinationSessionId = destinationSessionId;
  pendingTerminalRebounds.set(terminalId, pending);
  return pending;
}

export function getPendingTerminalRebound(
  terminalId: string,
): PendingTerminalRebound | undefined {
  return pendingTerminalRebounds.get(terminalId);
}

export function completePendingTerminalRebound(terminalId: string): void {
  pendingTerminalRebounds.delete(terminalId);
}

export function retainPendingTerminalRebounds(terminalIds: ReadonlySet<string>): void {
  for (const terminalId of pendingTerminalRebounds.keys()) {
    if (!terminalIds.has(terminalId)) pendingTerminalRebounds.delete(terminalId);
  }
}

export function listPendingTerminalReboundDestinations(): string[] {
  return [...new Set(
    [...pendingTerminalRebounds.values()].map((pending) => pending.destinationSessionId),
  )];
}

export function takePendingTerminalReboundsForDestination(
  sessionId: string,
): Array<{ terminalId: string; pending: PendingTerminalRebound }> {
  const matches: Array<{ terminalId: string; pending: PendingTerminalRebound }> = [];
  for (const [terminalId, pending] of pendingTerminalRebounds) {
    if (pending.destinationSessionId !== sessionId) continue;
    pendingTerminalRebounds.delete(terminalId);
    matches.push({ terminalId, pending });
  }
  return matches;
}

export function isPendingTerminalReboundSource(sessionId: string): boolean {
  return [...pendingTerminalRebounds.values()]
    .some((pending) => pending.sourceSessionIds.has(sessionId));
}

export function isPendingTerminalReboundDestination(sessionId: string): boolean {
  return [...pendingTerminalRebounds.values()]
    .some((pending) => pending.destinationSessionId === sessionId);
}

export function removePendingTerminalReboundSource(
  terminalId: string,
  sessionId: string,
): void {
  const pending = pendingTerminalRebounds.get(terminalId);
  if (!pending) return;
  pending.sourceSessionIds.delete(sessionId);
  if (pending.sourceSessionIds.size === 0) pendingTerminalRebounds.delete(terminalId);
}

export function resetPendingTerminalReboundsForTests(): void {
  pendingTerminalRebounds.clear();
}
