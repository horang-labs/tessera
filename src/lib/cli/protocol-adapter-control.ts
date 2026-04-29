import type { CliCommandInfo, CliMessage } from './types';
import type { AppServerMessage } from '../ws/message-types';
import logger from '../logger';

interface ControlResponseHandlerArgs {
  msg: CliMessage;
  sendAppMessage: (userId: string, message: AppServerMessage) => void;
  sessionId: string;
  storeCommands: (sessionId: string, commands: CliCommandInfo[]) => void;
  userId: string;
}

export function handleProtocolControlResponse({
  msg,
  sendAppMessage,
  sessionId,
  storeCommands,
  userId,
}: ControlResponseHandlerArgs): void {
  const response = msg.response;
  if (!response) {
    logger.debug({ sessionId }, 'control_response without response body');
    return;
  }

  if (response.subtype === 'error') {
    logger.warn({ sessionId, error: response.error, requestId: response.request_id }, 'control_response error');
    return;
  }

  const payload = response.response;
  if (payload && Array.isArray(payload.commands)) {
    const commands = payload.commands
      .filter((command: any) => command && typeof command.name === 'string')
      .map((command: any) => ({
        name: command.name as string,
        description: (command.description as string) || '',
      }));

    storeCommands(sessionId, commands);

    sendAppMessage(userId, {
      type: 'commands_ready',
      sessionId,
      commands,
      timestamp: new Date().toISOString(),
    });

    logger.info({ sessionId, commandCount: commands.length }, 'CLI commands received via initialize');
    return;
  }

  logger.debug({
    sessionId,
    requestId: response.request_id,
    hasPayload: !!payload,
    payloadKeys: payload ? Object.keys(payload).join(',') : 'none',
  }, 'control_response without commands (non-initialize response)');
}
