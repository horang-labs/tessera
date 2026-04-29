import type { EnhancedMessage, SessionStatus } from '@/types/chat';

export function hasConversationHistory(messages: EnhancedMessage[] | undefined): boolean {
  return (messages ?? []).some((message) => {
    if (message.type === 'text') {
      return message.role !== 'system';
    }

    return message.type !== 'system';
  });
}

export function shouldResumeBeforeSend({
  hasExistingConversation,
  isStopped,
  sessionStatus,
}: {
  hasExistingConversation: boolean;
  isStopped?: boolean;
  sessionStatus: SessionStatus;
}): boolean {
  return Boolean(isStopped && sessionStatus !== 'starting' && hasExistingConversation);
}
