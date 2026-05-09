import type { ServerTransportMessage } from '@/lib/ws/message-types';
import { TerminalManager } from './terminal-manager';

type SendToUser = (userId: string, message: ServerTransportMessage) => void;

let sendToUserRef: SendToUser | null = null;

export const terminalManager = new TerminalManager((userId, message) => {
  sendToUserRef?.(userId, message);
});

export function bindTerminalSender(sendToUser: SendToUser): TerminalManager {
  sendToUserRef = sendToUser;
  return terminalManager;
}
