import { v4 as uuidv4 } from 'uuid';
import { useChatStore } from '@/stores/chat-store';
import { useSessionStore } from '@/stores/session-store';
import { useTaskStore } from '@/stores/task-store';
import { buildUserMessageDisplayContent } from '@/lib/chat/build-user-message-display-content';
import { generateSessionTitle } from '@/lib/session/title-generator';
import { i18n } from '@/lib/i18n';
import type {
  ClientMessage,
  ContentBlock,
  TextContentBlock,
} from './message-types';
import { startTurnInFlight } from '@/lib/chat/session-client-effects';

type ClientMessageType = ClientMessage['type'];

type ClientMessagePayload<T extends ClientMessageType> = Omit<
  Extract<ClientMessage, { type: T }>,
  'type' | 'requestId'
>;

export function buildClientRequest<T extends ClientMessageType>(
  type: T,
  payload: ClientMessagePayload<T>,
): Extract<ClientMessage, { type: T }> {
  return {
    type,
    requestId: uuidv4(),
    ...payload,
  } as Extract<ClientMessage, { type: T }>;
}

export function applyOptimisticUserMessage(
  sessionId: string,
  content: string | ContentBlock[],
  skillName?: string,
  displayContent?: string | ContentBlock[],
): void {
  const resolvedDisplayContent = buildUserMessageDisplayContent(
    displayContent ?? content,
    skillName,
  );
  const chatStore = useChatStore.getState();

  chatStore.addMessage(sessionId, {
    id: uuidv4(),
    type: 'text',
    role: 'user',
    content: resolvedDisplayContent,
    timestamp: new Date().toISOString(),
  });

  const sessionStore = useSessionStore.getState();
  sessionStore.updateSessionStatus(sessionId, 'running');

  maybeUpdateOptimisticSessionTitle(sessionId, content);
  startTurnInFlight(sessionId);
}

function maybeUpdateOptimisticSessionTitle(
  sessionId: string,
  content: string | ContentBlock[],
): void {
  const sessionStore = useSessionStore.getState();
  const currentSession = sessionStore.getSession(sessionId);
  if (currentSession?.hasCustomTitle) {
    return;
  }

  const freshMessages = useChatStore.getState().messages.get(sessionId) || [];
  const userMessages = freshMessages.filter(
    (message) => 'role' in message && message.role === 'user',
  );
  if (userMessages.length !== 1) {
    return;
  }

  const title = generateSessionTitle(extractTitleText(content));
  if (title) {
    sessionStore.updateSessionTitle(sessionId, title);
    useTaskStore.getState().syncLinkedTaskTitle(sessionId, title);
  }
}

function extractTitleText(content: string | ContentBlock[]): string {
  if (typeof content === 'string') {
    return content;
  }

  const firstText = content.find(
    (block): block is TextContentBlock => block.type === 'text',
  );
  return firstText?.text ?? i18n.t('chat.imageFallback');
}
