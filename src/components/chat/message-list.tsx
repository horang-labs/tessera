'use client';

import { useMemo, useState, useCallback, useEffect, useRef } from 'react';
import type { EnhancedMessage, ToolCallMessage } from '@/types/chat';
import { MessageBubble } from './message-bubble';
import { LoadingIndicator } from './loading-indicator';
import { WaitingIndicator } from './waiting-indicator';
import { useChatStore } from '@/stores/chat-store';
import { useSessionStore } from '@/stores/session-store';
import { groupMessages, type GroupedItem } from '@/lib/chat/group-messages';
import { ToolCallGrid } from './tool-call-grid';
import { AgentMessageGroup } from './agent-message-group';
import { useShowWaitingIndicator } from '@/hooks/use-show-waiting-indicator';
import { useVirtualMessageList } from '@/hooks/use-virtual-message-list';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { SINGLE_PANEL_CONTENT_SHELL } from './single-panel-shell';
import {
  MessageListEmptyState,
  MessageListLoadMoreButton,
  MessageListScrollArea,
  MessageListScrollToBottomButton,
  MessageListToolCallOverlay,
} from './message-list-sections';

interface MessageListProps {
  messages: EnhancedMessage[];
  isLoading: boolean;
  sessionId: string;
  hasMore: boolean;
  onLoadMore: () => Promise<void> | void;
  isLoadingMore: boolean;
  isSinglePanel?: boolean;
  isTabActive?: boolean;
  isTurnInFlight?: boolean;
  search?: {
    activeMatchMessageId: string | null;
    activeGroupedRowIndex: number;
  };
}

// ---------------------------------------------------------------------------
// Single virtual row renderer
// ---------------------------------------------------------------------------

function VirtualRow({
  item,
  isNew,
  sessionId,
  providerId,
  onSelectToolCall,
  selectedToolCallId,
}: {
  item: GroupedItem;
  isNew: boolean;
  sessionId: string;
  providerId?: string;
  onSelectToolCall: (toolCall: ToolCallMessage | null) => void;
  selectedToolCallId: string | null;
}) {
  if (item.kind === 'tool_call_group') {
    return (
      <ToolCallGrid
        toolCalls={item.messages}
        onSelectToolCall={onSelectToolCall}
        selectedToolCallId={selectedToolCallId}
      />
    );
  }
  if (item.kind === 'agent_message_group') {
    return (
      <AgentMessageGroup
        group={item}
        providerId={providerId}
        onSelectToolCall={onSelectToolCall}
        selectedToolCallId={selectedToolCallId}
        disableAnimation={!isNew}
      />
    );
  }
  return (
    <MessageBubble
      message={item.message}
      sessionId={sessionId}
      providerId={providerId}
      disableAnimation={!isNew}
    />
  );
}

// ---------------------------------------------------------------------------
// MessageListSessionView — virtualized
// ---------------------------------------------------------------------------

function MessageListSessionView({
  messages,
  isLoading,
  sessionId,
  hasMore,
  onLoadMore,
  isLoadingMore,
  isSinglePanel = false,
  isTabActive = true,
  isTurnInFlight = false,
  search,
}: MessageListProps) {
  'use no memo'; // React Compiler caches virtualizer.getVirtualItems() on the stable instance ref — but the virtualizer is mutable, so we must opt out.
  const { t } = useI18n();
  const [selectedToolCallId, setSelectedToolCallId] = useState<string | null>(null);
  const providerId = useSessionStore((state) => state.getSession(sessionId)?.provider);
  const showWaitingIndicator = useShowWaitingIndicator(sessionId, messages);
  const hasActivePrompt = useChatStore((state) => state.activeInteractivePrompt.has(sessionId));

  // Group consecutive tool_call messages for grid rendering
  const groupedMessages = useMemo(() => groupMessages(messages), [messages]);

  // Scroll container ref — shared between ScrollArea and virtualizer
  const containerRef = useRef<HTMLDivElement>(null);

  const {
    virtualizer,
    autoScroll,
    setAutoScroll,
    handleScroll,
    handleWheel,
    handleLoadMore,
    scrollToBottom,
    newItemKeys,
  } = useVirtualMessageList({
    groupedMessages,
    scrollContainerRef: containerRef,
    sessionId,
    onLoadMore,
    showWaitingIndicator,
    hasActivePrompt,
    isTabActive,
    isTurnInFlight,
  });

  const activeSearchGroupedRowIndex = search?.activeGroupedRowIndex ?? -1;
  const activeSearchMatchMessageId = search?.activeMatchMessageId ?? null;

  useEffect(() => {
    if (activeSearchGroupedRowIndex < 0 || !activeSearchMatchMessageId) return;
    virtualizer.scrollToIndex(activeSearchGroupedRowIndex, {
      align: 'center',
      behavior: 'smooth',
    });
  }, [activeSearchGroupedRowIndex, activeSearchMatchMessageId, virtualizer]);

  // 선택된 도구호출을 groupedMessages에서 찾기
  const selectedToolCall = useMemo(() => {
    if (!selectedToolCallId) return null;
    const findToolCall = (messages: ToolCallMessage[]) =>
      messages.find(tc => tc.id === selectedToolCallId) ?? null;

    for (const item of groupedMessages) {
      if (item.kind === 'tool_call_group') {
        const found = findToolCall(item.messages);
        if (found) return found;
      } else if (item.kind === 'agent_message_group') {
        for (const subgroup of item.subgroups) {
          for (const groupItem of subgroup.items) {
            if (groupItem.kind !== 'tool_call_group') continue;
            const found = findToolCall(groupItem.messages);
            if (found) return found;
          }
        }
      }
    }
    return null;
  }, [selectedToolCallId, groupedMessages]);

  // 도구호출 선택/해제 콜백
  const onSelectToolCall = useCallback((toolCall: ToolCallMessage | null) => {
    setSelectedToolCallId(prev => {
      if (toolCall === null) return null;
      return prev === toolCall.id ? null : toolCall.id;
    });
  }, []);

  // 빈 영역 mousedown 시 기존 텍스트 선택 해제 (click 시점 selection 잔존 방지)
  const handleContentAreaMouseDown = useCallback((e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    if (target.closest('[data-cell-id], button, a, input, textarea, [role="button"]')) return;
    const selection = window.getSelection();
    if (selection && selection.toString().length > 0) {
      selection.removeAllRanges();
    }
  }, []);

  // 스크롤 영역 클릭: 툴 상세 패널 닫기 + 빈 영역 클릭 시 입력창 포커스
  const handleContentAreaClick = useCallback((e: React.MouseEvent) => {
    const target = e.target as HTMLElement;

    // 툴 셀 내부 클릭이면 기존 toggle 로직에 맡김
    if (target.closest('[data-cell-id]')) return;

    // 열린 패널 닫기
    if (selectedToolCallId) {
      setSelectedToolCallId(null);
    }

    // 인터랙티브 요소 클릭이면 포커스 안 함
    if (target.closest('button, a, input, textarea, [role="button"]')) return;

    // 드래그 선택 중이면 포커스 안 함
    const selection = window.getSelection();
    if (selection && selection.toString().length > 0) return;

    // 빈 영역 클릭 → 입력창 포커스
    const textarea = document.querySelector(`textarea[data-session-input="${sessionId}"]`) as HTMLTextAreaElement;
    textarea?.focus();
  }, [selectedToolCallId, sessionId]);

  const contentShellClassName = cn(
    'w-full min-h-full',
    isSinglePanel ? SINGLE_PANEL_CONTENT_SHELL : 'px-4'
  );

  if (isLoading && messages.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center h-full">
        <div className="text-center">
          <LoadingIndicator isVisible={true} />
          <p className="mt-4 text-(--text-muted) text-sm">{t('chat.loadingHistory')}</p>
        </div>
      </div>
    );
  }

  // Virtual items to render
  const virtualItems = virtualizer.getVirtualItems();
  const totalSize = virtualizer.getTotalSize();
  const showScrollToBottomButton = messages.length > 0 && !autoScroll;

  return (
    <div className="h-full relative">
      <MessageListScrollArea
        containerRef={containerRef}
        onScroll={handleScroll}
        onWheel={handleWheel}
        onMouseDown={handleContentAreaMouseDown}
        onClick={handleContentAreaClick}
        sessionId={sessionId}
      >
        <div className={contentShellClassName}>
          {messages.length === 0 ? (
            showWaitingIndicator ? (
              <div className="pt-3">
                <WaitingIndicator providerId={providerId} />
              </div>
            ) : (
              <MessageListEmptyState
                startConversationLabel={t('chat.startConversation')}
                typeMessageLabel={t('chat.typeMessage')}
              />
            )
          ) : (
            <div className="pt-3">
              {hasMore && (
                <MessageListLoadMoreButton
                  isLoadingMore={isLoadingMore}
                  label={t('chat.loadMore')}
                  loadingLabel={t('chat.loadingMore')}
                  onClick={() => { void handleLoadMore(); }}
                />
              )}

              {/* Virtual list container — total height creates scrollable area */}
              <div
                style={{ height: totalSize, width: '100%', position: 'relative' }}
              >
                {virtualItems.map((virtualRow) => {
                  const item = groupedMessages[virtualRow.index];
                  const key = virtualRow.key as string;
                  const isActiveSearchRow =
                    activeSearchGroupedRowIndex === virtualRow.index &&
                    activeSearchMatchMessageId != null;
                  return (
                    <div
                      key={key}
                      data-index={virtualRow.index}
                      data-item-key={key}
                      data-search-active-match={isActiveSearchRow ? 'true' : undefined}
                      ref={virtualizer.measureElement}
                      className={cn(
                        'rounded-md transition-colors',
                        isActiveSearchRow && 'bg-(--accent)/10 ring-1 ring-(--accent)/30',
                      )}
                      style={{
                        position: 'absolute',
                        top: 0,
                        left: 0,
                        width: '100%',
                        transform: `translateY(${virtualRow.start}px)`,
                      }}
                    >
                      <VirtualRow
                        item={item}
                        isNew={newItemKeys.has(key)}
                        sessionId={sessionId}
                        providerId={providerId}
                        onSelectToolCall={onSelectToolCall}
                        selectedToolCallId={selectedToolCallId}
                      />
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {messages.length > 0 && showWaitingIndicator && <WaitingIndicator providerId={providerId} />}
        </div>
      </MessageListScrollArea>

      {selectedToolCall && (
        <MessageListToolCallOverlay
          toolCall={selectedToolCall}
          onClose={() => setSelectedToolCallId(null)}
        />
      )}

      {showScrollToBottomButton && (
        <MessageListScrollToBottomButton
          onClick={() => {
            setAutoScroll(true);
            scrollToBottom();
          }}
          title={t('chat.scrollToBottom')}
        />
      )}
    </div>
  );
}

export function MessageList(props: MessageListProps) {
  return <MessageListSessionView key={props.sessionId} {...props} />;
}
