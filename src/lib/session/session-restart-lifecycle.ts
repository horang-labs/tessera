type SessionRestartListener = (succeeded: boolean, message?: string) => void;

const restartingSessionIds = new Set<string>();
const listenersBySessionId = new Map<string, Set<SessionRestartListener>>();

export function beginSessionRestart(sessionId: string): void {
  restartingSessionIds.add(sessionId);
}

export function isSessionRestarting(sessionId: string): boolean {
  return restartingSessionIds.has(sessionId);
}

/** A disconnected client cannot rely on receiving the matching restart outcome. */
export function resetSessionRestarts(): void {
  restartingSessionIds.clear();
}

export function finishSessionRestart(
  sessionId: string,
  succeeded: boolean,
  message?: string,
): void {
  restartingSessionIds.delete(sessionId);
  for (const listener of listenersBySessionId.get(sessionId) ?? []) {
    listener(succeeded, message);
  }
}

export function subscribeSessionRestart(
  sessionId: string,
  listener: SessionRestartListener,
): () => void {
  const listeners = listenersBySessionId.get(sessionId) ?? new Set<SessionRestartListener>();
  listeners.add(listener);
  listenersBySessionId.set(sessionId, listeners);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) listenersBySessionId.delete(sessionId);
  };
}
