import { randomUUID } from 'node:crypto';
import type { ServerTransportMessage } from './message-types';

export const SESSION_OPEN_RESPONSE_TIMEOUT_MS = 10_000;

export interface SessionOpenRequestOutcome {
  deliveredClients: number;
  openedClients: number;
}

interface PendingSessionOpen {
  userId: string;
  expected: number;
  responded: number;
  opened: number;
  finish: () => void;
}

const pendingOpens = new Map<string, PendingSessionOpen>();

/**
 * Ask every UI connection of the user to show a Session and wait for their
 * answers. Resolves on the first client that shows it, once every client has
 * declined, or at the timeout, so the caller can report what really happened.
 */
export function requestSessionOpen(options: {
  userId: string;
  sessionId: string;
  /** Sends to the user's connections and returns how many it reached. */
  sendToUser: (userId: string, message: ServerTransportMessage) => number;
  timeoutMs?: number;
}): Promise<SessionOpenRequestOutcome> {
  const openId = randomUUID();
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const pending: PendingSessionOpen = {
      userId: options.userId,
      expected: 0,
      responded: 0,
      opened: 0,
      finish: () => {
        if (!pendingOpens.delete(openId)) return;
        if (timer) clearTimeout(timer);
        resolve({ deliveredClients: pending.expected, openedClients: pending.opened });
      },
    };
    pendingOpens.set(openId, pending);
    pending.expected = options.sendToUser(options.userId, {
      type: 'session_open_request',
      openId,
      sessionId: options.sessionId,
    });
    if (pending.expected === 0) {
      pending.finish();
      return;
    }
    timer = setTimeout(pending.finish, options.timeoutMs ?? SESSION_OPEN_RESPONSE_TIMEOUT_MS);
  });
}

/** Record one UI connection's answer to a pending open request. */
export function resolveSessionOpenResponse(
  userId: string,
  openId: string,
  opened: boolean,
): void {
  const pending = pendingOpens.get(openId);
  if (!pending || pending.userId !== userId) return;
  pending.responded += 1;
  if (opened) pending.opened += 1;
  if (pending.opened > 0 || pending.responded >= pending.expected) pending.finish();
}
