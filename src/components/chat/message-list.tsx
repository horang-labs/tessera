'use client';

import { useMemo, useState, useCallback, useEffect, useRef } from 'react';
import type { EnhancedMessage, ToolCallMessage } from '@/types/chat';
import { MessageBubble } from './message-bubble';
import { LoadingIndicator } from './loading-indicator';
import { WaitingIndicator } from './waiting-indicator';
import { useChatStore } from '@/stores/chat-store';
import { useSessionStore } from '@/stores/session-store';
import { useCollectionStore } from '@/stores/collection-store';
import { useSettingsStore } from '@/stores/settings-store';
import { groupMessages, type GroupedItem } from '@/lib/chat/group-messages';
import { ToolCallGrid } from './tool-call-grid';
import { AgentMessageGroup } from './agent-message-group';
import { useShowWaitingIndicator } from '@/hooks/use-show-waiting-indicator';
import { useVirtualMessageList } from '@/hooks/use-virtual-message-list';
import { useWebSocket } from '@/hooks/use-websocket';
import { useI18n } from '@/lib/i18n';
import {
  applyProviderSessionRuntimeOverrides,
  getProviderSessionRuntimeConfig,
} from '@/lib/settings/provider-defaults';
import {
  exportSessionReference,
  formatForkConversationPrompt,
} from '@/lib/session/session-reference';
import { cn } from '@/lib/utils';
import { toast } from '@/stores/notification-store';
import type { Collection } from '@/types/collection';
import type { ForkFromMessageHandler } from './message-bubble-content';
import { CollectionQuickCreateSheet } from './collection-quick-create-sheet';
import { SINGLE_PANEL_CONTENT_SHELL } from './single-panel-shell';
import {
  MessageListEmptyState,
  MessageListLoadMoreButton,
  MessageListScrollArea,
  MessageListScrollToBottomButton,
  MessageListToolCallOverlay,
} from './message-list-sections';

const EMPTY_COLLECTIONS: Collection[] = [];

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
  onForkFromMessage,
}: {
  item: GroupedItem;
  isNew: boolean;
  sessionId: string;
  providerId?: string;
  onSelectToolCall: (toolCall: ToolCallMessage | null) => void;
  selectedToolCallId: string | null;
  onForkFromMessage?: ForkFromMessageHandler;
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
        onForkFromMessage={onForkFromMessage}
      />
    );
  }
  return (
    <MessageBubble
      message={item.message}
      sessionId={sessionId}
      providerId={providerId}
      disableAnimation={!isNew}
      onForkFromMessage={onForkFromMessage}
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
  const [forkSource, setForkSource] = useState<{
    message: EnhancedMessage;
    messageIndex: number;
  } | null>(null);
  const [isInjectingFork, setIsInjectingFork] = useState(false);
  const forkAnchorRef = useRef<HTMLElement | null>(null);
  const messagesRef = useRef(messages);
  const session = useSessionStore((state) => state.getSession(sessionId));
  const projects = useSessionStore((state) => state.projects);
  const providerId = session?.provider;
  const { sendMessage } = useWebSocket();
  const showWaitingIndicator = useShowWaitingIndicator(sessionId, messages);
  const hasActivePrompt = useChatStore((state) => state.activeInteractivePrompt.has(sessionId));
  const activeProject = useMemo(() => {
    if (!session) return null;
    return projects.find((project) =>
      project.encodedDir === session.projectDir ||
      project.decodedPath === session.projectDir ||
      project.decodedPath === session.workDir
    ) ?? null;
  }, [projects, session]);
  const activeProjectId = activeProject?.encodedDir ?? null;
  const collections = useCollectionStore((state) =>
    activeProjectId ? state.collectionsByProject?.[activeProjectId] ?? EMPTY_COLLECTIONS : EMPTY_COLLECTIONS
  );
  const activeCollection = useMemo(() => {
    if (!session?.collectionId) return null;
    return collections.find((collection) => collection.id === session.collectionId) ?? null;
  }, [collections, session?.collectionId]);

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
    messagesRef.current = messages;
  }, [messages]);

  useEffect(() => {
    if (!activeProjectId) return;
    void useCollectionStore.getState().loadCollections(activeProjectId);
  }, [activeProjectId]);

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

  const handleForkFromMessage = useCallback<ForkFromMessageHandler>((message, anchorElement) => {
    if (!activeProject || isInjectingFork) {
      return;
    }

    const messageIndex = messagesRef.current.findIndex((item) => item === message || item.id === message.id);
    if (messageIndex < 0) {
      toast.error(t('errors.sessionExportFailed'));
      return;
    }

    forkAnchorRef.current = anchorElement;
    setSelectedToolCallId(null);
    setForkSource({ message, messageIndex });
  }, [activeProject, isInjectingFork, t]);

  const handleInjectForkSession = useCallback(async (targetSessionId: string) => {
    if (!forkSource) return;

    setIsInjectingFork(true);
    try {
      const exportPath = await exportSessionReference(sessionId, {
        untilMessageId: forkSource.message.id,
        untilMessageIndex: forkSource.messageIndex,
      });
      const targetSession = useSessionStore.getState().getSession(targetSessionId);
      const { settings } = useSettingsStore.getState();
      const targetProviderId = targetSession?.provider?.trim();
      if (!targetProviderId) {
        toast.error(t('errors.providerRequired'));
        return;
      }
      const spawnConfig = !(targetSession?.isRunning ?? false)
        ? applyProviderSessionRuntimeOverrides(
            getProviderSessionRuntimeConfig(settings, targetProviderId),
            targetSession,
            targetProviderId,
          )
        : undefined;
      const referenceContent = formatForkConversationPrompt(exportPath);

      sendMessage(targetSessionId, referenceContent, undefined, referenceContent, spawnConfig);
      setForkSource(null);
    } catch {
      toast.error(t('errors.sessionExportFailed'));
    } finally {
      setIsInjectingFork(false);
    }
  }, [forkSource, sendMessage, sessionId, t]);

  const forkContinuationTitle = session
    ? `${session.title} · ${t('chat.forkPointLabel')}`
    : t('chat.forkPointLabel');

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
                        onForkFromMessage={activeProject ? handleForkFromMessage : undefined}
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

      {forkSource && activeProject && (
        <CollectionQuickCreateSheet
          collection={activeCollection}
          collections={collections}
          projectDir={activeProject.decodedPath}
          projectId={activeProject.encodedDir}
          allowCollectionSelection
          anchorRef={forkAnchorRef}
          boundaryRef={forkAnchorRef}
          anchorPlacement="side"
          scopeId={`fork-${sessionId}`}
          continuationSourceTitle={forkContinuationTitle}
          onSessionCreated={handleInjectForkSession}
          onClose={() => setForkSource(null)}
        />
      )}

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
