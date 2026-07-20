'use client';

import { ArrowUp, MessageSquare } from 'lucide-react';
import type { ToolCallMessage } from '@/types/chat';
import { ToolCallDetailPanel } from './tool-call-detail-panel';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Button } from '@/components/ui/button';
import { ScrollToBottomButton } from '@/components/ui/scroll-to-bottom-button';
import { LoadingIndicator } from './loading-indicator';

interface MessageListScrollAreaProps {
  children: React.ReactNode;
  containerRef: React.RefObject<HTMLDivElement | null>;
  onClick: (event: React.MouseEvent) => void;
  onMouseDown: (event: React.MouseEvent) => void;
  onScroll: () => void;
  onWheel: (event: React.WheelEvent<HTMLDivElement>) => void;
  sessionId: string;
}

interface MessageListEmptyStateProps {
  startConversationLabel: string;
  typeMessageLabel: string;
}

interface MessageListLoadMoreButtonProps {
  isLoadingMore: boolean;
  label: string;
  loadingLabel: string;
  onClick: () => void;
}

interface MessageListToolCallOverlayProps {
  onClose: () => void;
  toolCall: ToolCallMessage;
}

interface MessageListScrollToBottomButtonProps {
  onClick: () => void;
  title: string;
}

export function MessageListScrollArea({
  children,
  containerRef,
  onClick,
  onMouseDown,
  onScroll,
  onWheel,
  sessionId,
}: MessageListScrollAreaProps) {
  return (
    <ScrollArea
      className="h-full pb-3 overflow-x-hidden [overflow-anchor:none]"
      ref={containerRef}
      data-session-messages={sessionId}
      onScroll={onScroll}
      onWheel={onWheel}
      onMouseDown={onMouseDown}
      onClick={onClick}
    >
      {children}
    </ScrollArea>
  );
}

export function MessageListEmptyState({
  startConversationLabel,
  typeMessageLabel,
}: MessageListEmptyStateProps) {
  return (
    <div className="flex items-center justify-center h-full pt-3">
      <div className="text-center">
        <div className="w-14 h-14 rounded-xl bg-(--sidebar-hover) flex items-center justify-center mx-auto mb-4">
          <MessageSquare className="w-7 h-7 text-(--accent) opacity-60" />
        </div>
        <p className="text-base font-medium text-(--text-secondary)">{startConversationLabel}</p>
        <p className="text-xs text-(--text-muted) mt-2">{typeMessageLabel}</p>
      </div>
    </div>
  );
}

export function MessageListLoadMoreButton({
  isLoadingMore,
  label,
  loadingLabel,
  onClick,
}: MessageListLoadMoreButtonProps) {
  return (
    <div className="px-2 py-2 mb-2">
      <Button
        variant="outline"
        size="sm"
        onClick={onClick}
        disabled={isLoadingMore}
        className="w-full"
        data-testid="load-more-messages-button"
      >
        {isLoadingMore ? (
          <>
            <LoadingIndicator isVisible={true} />
            <span className="ml-2">{loadingLabel}</span>
          </>
        ) : (
          <>
            <ArrowUp className="w-4 h-4 mr-2" />
            {label}
          </>
        )}
      </Button>
    </div>
  );
}

export function MessageListToolCallOverlay({
  onClose,
  toolCall,
}: MessageListToolCallOverlayProps) {
  return (
    <div className="absolute bottom-0 left-0 right-0 z-20">
      <div className="w-full px-4">
        <ToolCallDetailPanel
          toolCall={toolCall}
          onClose={onClose}
        />
      </div>
    </div>
  );
}

export function MessageListScrollToBottomButton({
  onClick,
  title,
}: MessageListScrollToBottomButtonProps) {
  return <ScrollToBottomButton onClick={onClick} title={title} />;
}
