import {
  TerminalSessionWaitTimeoutError,
  type TerminalManager,
} from '@/lib/terminal/terminal-manager';
import { terminalManager } from '@/lib/terminal/shared-terminal-manager';
import {
  ControlOperationError,
  type ControlSessionObserver,
} from './service';

/** Adapt the shared terminal module to the single-user local Control interface. */
export function createTerminalControlSessionObserver(options: {
  userId?: string;
  resolveUserId?: () => Promise<string | undefined>;
  manager?: Pick<TerminalManager, 'readSessionSnapshot' | 'waitForSessionState'>;
}): ControlSessionObserver {
  const manager = options.manager ?? terminalManager;
  let resolvedUserId = options.userId;
  let resolvingUserId: Promise<string | undefined> | undefined;

  const requireUserId = async (): Promise<string> => {
    if (resolvedUserId) return resolvedUserId;
    resolvingUserId ??= Promise.resolve(options.resolveUserId?.());
    const userId = await resolvingUserId;
    if (userId) {
      resolvedUserId = userId;
      return userId;
    }
    resolvingUserId = undefined;
    throw new ControlOperationError(
      'INSTANCE_UNAVAILABLE',
      'The Tessera user context is unavailable.',
      503,
    );
  };

  return {
    async read(sessionId) {
      return manager.readSessionSnapshot(sessionId, await requireUserId());
    },

    async wait(sessionId, condition, timeoutMs) {
      try {
        return await manager.waitForSessionState(
          sessionId,
          await requireUserId(),
          condition,
          timeoutMs,
        );
      } catch (error) {
        if (!(error instanceof TerminalSessionWaitTimeoutError)) throw error;
        throw new ControlOperationError(
          'SESSION_WAIT_TIMEOUT',
          `The Session did not reach ${condition} before the timeout.`,
          408,
          { sessionId, condition, timeoutSeconds: timeoutMs / 1_000 },
        );
      }
    },
  };
}
