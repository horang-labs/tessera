import {
  TerminalSessionInputError,
  TerminalSessionRuntimeNotRunningError,
  type TerminalManager,
} from '@/lib/terminal/terminal-manager';
import { terminalManager } from '@/lib/terminal/shared-terminal-manager';
import {
  ControlOperationError,
  type ControlSessionRuntimeController,
} from './service';
import { createRequiredControlUserIdResolver } from './required-user-context';

/** Adapt the shared PTY owner to stable Control errors and single-user authorization. */
export function createTerminalControlSessionController(options: {
  userId?: string;
  resolveUserId?: () => Promise<string | undefined>;
  manager?: Pick<
    TerminalManager,
    'submitSessionPrompt' | 'sendSessionKeys' | 'stopSessionRuntime'
  >;
}): ControlSessionRuntimeController {
  const manager = options.manager ?? terminalManager;
  const requireUserId = createRequiredControlUserIdResolver(options);

  return {
    async prompt(sessionId, text) {
      return mapControlInputError(
        async () => manager.submitSessionPrompt(sessionId, await requireUserId(), text),
        sessionId,
      );
    },

    async sendKeys(sessionId, keys) {
      return mapControlInputError(
        async () => manager.sendSessionKeys(sessionId, await requireUserId(), keys),
        sessionId,
      );
    },

    async stop(sessionId) {
      return mapControlInputError(
        async () => manager.stopSessionRuntime(sessionId, await requireUserId()),
        sessionId,
      );
    },
  };
}

async function mapControlInputError<T>(operation: () => Promise<T>, sessionId: string): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof TerminalSessionRuntimeNotRunningError) {
      throw new ControlOperationError(
        'SESSION_RUNTIME_NOT_RUNNING',
        error.message,
        409,
        { sessionId },
      );
    }
    if (error instanceof TerminalSessionInputError) {
      throw new ControlOperationError('INPUT_NOT_ACCEPTED', error.message, 409, { sessionId });
    }
    throw error;
  }
}
