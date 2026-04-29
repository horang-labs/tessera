'use client';

import { memo } from 'react';
import type { EnhancedMessage } from '@/types/chat';
import { MessageErrorBoundary } from './message-error-boundary';
import { renderEnhancedContent } from './message-bubble-content';

interface MessageBubbleProps {
  message: EnhancedMessage;
  sessionId: string;
  providerId?: string;
  /** When true, suppress the CSS enter animation (e.g. items scrolling into a virtual viewport). */
  disableAnimation?: boolean;
}

export const MessageBubble = memo(
  function MessageBubble({
    message,
    sessionId,
    providerId,
    disableAnimation,
  }: MessageBubbleProps) {

  return (
    <MessageErrorBoundary>
      <div className={`py-1${disableAnimation ? '' : ' message-enter'}`}>
        {renderEnhancedContent(message, providerId)}
      </div>
    </MessageErrorBoundary>
  );
  },
  // Custom comparison function for memo optimization
  (prevProps, nextProps) => {
    // 메시지 ID와 내용이 동일하면 re-render 스킵
    const prevMsg = prevProps.message;
    const nextMsg = nextProps.message;

    // ID 비교 (기본)
    if (prevMsg.id !== nextMsg.id) return false;

    // Session ID 비교
    if (prevProps.sessionId !== nextProps.sessionId) return false;

    // Provider ID 비교
    if (prevProps.providerId !== nextProps.providerId) return false;

    // Animation 상태 비교
    if (prevProps.disableAnimation !== nextProps.disableAnimation) return false;

    // 메시지 내용 비교 (타입별)
    if (prevMsg.type !== nextMsg.type) return false;

    switch (prevMsg.type) {
      case 'text':
        return prevMsg.content === (nextMsg as any).content;
      case 'thinking':
        return (
          prevMsg.content === (nextMsg as any).content &&
          prevMsg.status === (nextMsg as any).status
        );
      default:
        return true; // system, progress_hook - timestamp만 다름
    }
  }
);
