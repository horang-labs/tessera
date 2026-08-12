import {
  TerminalSessionWaitTimeoutError,
  type TerminalManager,
  type TerminalSessionSnapshot,
} from '@/lib/terminal/terminal-manager';
import { terminalManager } from '@/lib/terminal/shared-terminal-manager';
import {
  ControlOperationError,
  type ControlSessionObserver,
} from './service';
import { createRequiredControlUserIdResolver } from './required-user-context';

/** Adapt the shared terminal module to the single-user local Control interface. */
export function createTerminalControlSessionObserver(options: {
  userId?: string;
  resolveUserId?: () => Promise<string | undefined>;
  manager?: Pick<TerminalManager, 'readSessionSnapshot' | 'waitForSessionState'>;
  readIntegrationHealth?: (sessionId: string) => 'healthy' | 'degraded' | undefined;
}): ControlSessionObserver {
  const manager = options.manager ?? terminalManager;
  const requireUserId = createRequiredControlUserIdResolver(options);
  const readIntegrationHealth = options.readIntegrationHealth ?? (() => undefined);
  const withIntegrationHealth = (sessionId: string, snapshot: TerminalSessionSnapshot) => {
    const integrationHealth = readIntegrationHealth(sessionId);
    return integrationHealth ? { ...snapshot, integrationHealth } : snapshot;
  };

  return {
    async read(sessionId) {
      return withIntegrationHealth(
        sessionId,
        await manager.readSessionSnapshot(sessionId, await requireUserId()),
      );
    },

    async wait(sessionId, condition, timeoutMs) {
      try {
        return withIntegrationHealth(
          sessionId,
          await manager.waitForSessionState(
            sessionId,
            await requireUserId(),
            condition,
            timeoutMs,
          ),
        );
      } catch (error) {
        if (!(error instanceof TerminalSessionWaitTimeoutError)) throw error;
        throw new ControlOperationError(
          'WAIT_TIMEOUT',
          `The Session did not reach ${condition} before the timeout.`,
          408,
          { sessionId, condition, timeoutSeconds: timeoutMs / 1_000 },
        );
      }
    },
  };
}
