import { wsServer } from '@/lib/ws/server';
import { requestSessionOpen } from '@/lib/ws/session-open-requests';
import type { ControlSessionOpener } from './service';
import { createRequiredControlUserIdResolver } from './required-user-context';

/** Show a Session in the user's connected Tessera windows. */
export function createWebSocketControlSessionOpener(options: {
  userId?: string;
  resolveUserId?: () => Promise<string | undefined>;
  timeoutMs?: number;
}): ControlSessionOpener {
  const requireUserId = createRequiredControlUserIdResolver(options);
  return {
    async open(sessionId) {
      return requestSessionOpen({
        userId: await requireUserId(),
        sessionId,
        sendToUser: (userId, message) => wsServer.sendToUser(userId, message),
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      });
    },
  };
}
