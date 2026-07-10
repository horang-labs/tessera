interface TerminalHandoffLock {
  sessionId: string;
  terminalId: string;
  userId: string;
}

interface TerminalHandoffState {
  locksBySession: Map<string, TerminalHandoffLock>;
  sessionsByTerminal: Map<string, string>;
  activeTesseraOperations: Map<string, number>;
}

// API routes and the custom WebSocket server can load separate compiled module
// instances. Keep the exclusion state on globalThis so REST mutations and
// terminal acquisition still coordinate across that bundling boundary and
// across Next.js hot reloads.
const TERMINAL_HANDOFF_STATE_KEY = Symbol.for('tessera.terminalHandoffState');
const globalState = globalThis as unknown as Record<symbol, TerminalHandoffState>;
const state = globalState[TERMINAL_HANDOFF_STATE_KEY]
  ?? (globalState[TERMINAL_HANDOFF_STATE_KEY] = {
    locksBySession: new Map<string, TerminalHandoffLock>(),
    sessionsByTerminal: new Map<string, string>(),
    activeTesseraOperations: new Map<string, number>(),
  });
const { locksBySession, sessionsByTerminal, activeTesseraOperations } = state;

export class TerminalHandoffConflictError extends Error {
  readonly code = 'session_handed_off_to_terminal';

  constructor() {
    super('Close the Codex terminal before changing this Tessera session.');
    this.name = 'TerminalHandoffConflictError';
  }
}

export function isTerminalHandoffConflictError(
  error: unknown,
): error is TerminalHandoffConflictError {
  return error instanceof TerminalHandoffConflictError
    || (
      error instanceof Error
      && 'code' in error
      && error.code === 'session_handed_off_to_terminal'
    );
}

function terminalKey(userId: string, terminalId: string): string {
  return `${userId}:${terminalId}`;
}

export function acquireTerminalHandoffLock(lock: TerminalHandoffLock): boolean {
  if ((activeTesseraOperations.get(lock.sessionId) ?? 0) > 0) {
    return false;
  }
  const key = terminalKey(lock.userId, lock.terminalId);
  const sessionForTerminal = sessionsByTerminal.get(key);
  if (sessionForTerminal && sessionForTerminal !== lock.sessionId) {
    return false;
  }
  const current = locksBySession.get(lock.sessionId);
  if (current) {
    return false;
  }
  locksBySession.set(lock.sessionId, lock);
  sessionsByTerminal.set(key, lock.sessionId);
  return true;
}

export function beginTesseraSessionOperation(sessionId: string): boolean {
  if (locksBySession.has(sessionId)) return false;
  activeTesseraOperations.set(sessionId, (activeTesseraOperations.get(sessionId) ?? 0) + 1);
  return true;
}

/**
 * Claims every session synchronously, rolling back the whole set if any one is
 * currently handed off. JavaScript cannot interleave another handoff between
 * these synchronous map operations, so callers can safely enter an async
 * multi-session mutation after this returns.
 */
export function beginTesseraSessionOperations(sessionIds: Iterable<string>): string[] | null {
  const acquired: string[] = [];
  for (const sessionId of new Set(sessionIds)) {
    if (!sessionId) continue;
    if (!beginTesseraSessionOperation(sessionId)) {
      endTesseraSessionOperations(acquired);
      return null;
    }
    acquired.push(sessionId);
  }
  return acquired;
}

export function endTesseraSessionOperation(sessionId: string): void {
  const current = activeTesseraOperations.get(sessionId) ?? 0;
  if (current <= 1) {
    activeTesseraOperations.delete(sessionId);
  } else {
    activeTesseraOperations.set(sessionId, current - 1);
  }
}

export function endTesseraSessionOperations(sessionIds: Iterable<string>): void {
  for (const sessionId of sessionIds) {
    endTesseraSessionOperation(sessionId);
  }
}

export async function withTesseraSessionOperations<T>(
  sessionIds: Iterable<string>,
  operation: () => Promise<T> | T,
): Promise<T> {
  const acquired = beginTesseraSessionOperations(sessionIds);
  if (!acquired) {
    throw new TerminalHandoffConflictError();
  }
  try {
    return await operation();
  } finally {
    endTesseraSessionOperations(acquired);
  }
}

export function withTesseraSessionOperation<T>(
  sessionId: string,
  operation: () => Promise<T> | T,
): Promise<T> {
  return withTesseraSessionOperations([sessionId], operation);
}

export function isSessionHandedOffToTerminal(sessionId: string): boolean {
  return locksBySession.has(sessionId);
}

export function assertSessionNotHandedOffToTerminal(sessionId: string): void {
  if (isSessionHandedOffToTerminal(sessionId)) {
    throw new TerminalHandoffConflictError();
  }
}

export function ownsTerminalHandoffLock(
  sessionId: string,
  userId: string,
  terminalId: string,
): boolean {
  const current = locksBySession.get(sessionId);
  return current?.userId === userId && current.terminalId === terminalId;
}

export function releaseTerminalHandoffByTerminal(userId: string, terminalId: string): void {
  const key = terminalKey(userId, terminalId);
  const sessionId = sessionsByTerminal.get(key);
  if (!sessionId) return;
  sessionsByTerminal.delete(key);
  const current = locksBySession.get(sessionId);
  if (current?.userId === userId && current.terminalId === terminalId) {
    locksBySession.delete(sessionId);
  }
}

export function releaseTerminalHandoffsForUser(userId: string): void {
  for (const lock of [...locksBySession.values()]) {
    if (lock.userId === userId) {
      releaseTerminalHandoffByTerminal(lock.userId, lock.terminalId);
    }
  }
}
