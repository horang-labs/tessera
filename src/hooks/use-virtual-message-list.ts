'use client';

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer, type Virtualizer } from '@tanstack/react-virtual';
import type { AgentBlockGroupItem, GroupedItem } from '@/lib/chat/group-messages';
import { useChatStore } from '@/stores/chat-store';
import type { EnhancedMessage } from '@/types/chat';

// ---------------------------------------------------------------------------
// Height estimation heuristics
// ---------------------------------------------------------------------------

/**
 * Rough height estimate per grouped item type.
 *
 * These don't need to be pixel-perfect — @tanstack/react-virtual will
 * remeasure via ResizeObserver once the element renders.  Good estimates
 * reduce layout shift on initial paint.
 */
function estimateGroupedItemHeight(item: GroupedItem): number {
  if (item.kind === 'tool_call_group') {
    return estimateToolCallGroupHeight(item.messages.length);
  }

  if (item.kind === 'agent_message_group') {
    return item.subgroups.reduce((total, subgroup) => {
      return total + 48 + subgroup.items.reduce((height, groupItem) => {
        if (groupItem.kind === 'tool_call_group') {
          return height + estimateToolCallGroupHeight(groupItem.messages.length);
        }
        if (groupItem.message.type === 'thinking') {
          return height + 60;
        }
        if (groupItem.message.type === 'text') {
          const content = typeof groupItem.message.content === 'string' ? groupItem.message.content : '';
          const lines = Math.max(1, Math.ceil(content.length / 80));
          return height + 40 + lines * 20;
        }
        return height + 40;
      }, 0);
    }, 0);
  }

  const msg = item.message;
  switch (msg.type) {
    case 'thinking':
      return 60;
    case 'system':
    case 'progress_hook':
      return 40;
    case 'text': {
      // Rough estimate: 80px base + 20px per ~80 chars line
      const content = typeof msg.content === 'string' ? msg.content : '';
      const lines = Math.max(1, Math.ceil(content.length / 80));
      return 80 + lines * 20;
    }
    default:
      return 80;
  }
}

function estimateToolCallGroupHeight(count: number): number {
  // 4+ tools → collapsed summary bar (~50px)
  // 1-3 tools → compact rows (~38px each + 16px wrapper margin)
  return count >= 4 ? 50 : count * 38 + 16;
}

/**
 * Stable key per grouped item — prevents remounts when items are prepended.
 */
function getGroupedItemKey(item: GroupedItem): string {
  if (item.kind === 'tool_call_group') {
    return `tcg-${item.messages[0].id}`;
  }
  if (item.kind === 'agent_message_group') {
    return `agent-${item.messages[0].id}`;
  }
  return item.message.id;
}

function getContentSizeSignature(content: unknown): string {
  if (typeof content === 'string') return `text:${content.length}`;
  if (Array.isArray(content)) {
    return `blocks:${content
      .map((block) => {
        if (block && typeof block === 'object' && 'text' in block) {
          return String((block as { text?: unknown }).text ?? '').length;
        }
        return 0;
      })
      .join(',')}`;
  }
  return content == null ? 'empty' : 'object';
}

function getMessageSizeSignature(message: EnhancedMessage): string {
  if (message.type === 'text' || message.type === 'thinking') {
    return `${message.id}:${message.type}:${getContentSizeSignature(message.content)}`;
  }
  if (message.type === 'tool_call') {
    return `${message.id}:${message.type}:${message.status}:${message.output?.length ?? 0}:${message.error?.length ?? 0}:${message.hasOutput ? '1' : '0'}`;
  }
  if (message.type === 'system') {
    return `${message.id}:${message.type}:${message.severity}:${message.message.length}`;
  }
  return `${message.id}:${message.type}:${message.hookEvent}:${message.errorMessage?.length ?? 0}`;
}

function getGroupedItemSizeSignature(item: GroupedItem | undefined): string {
  if (!item) return 'empty';
  if (item.kind === 'tool_call_group') {
    return `tcg:${item.messages.map(getMessageSizeSignature).join('|')}`;
  }
  if (item.kind === 'agent_message_group') {
    return `agent:${item.messages.length}:${item.subgroups
      .map((subgroup) => subgroup.items.map(getAgentBlockGroupItemSizeSignature).join(','))
      .join(';')}`;
  }
  return getMessageSizeSignature(item.message);
}

function getAgentBlockGroupItemSizeSignature(item: AgentBlockGroupItem | undefined): string {
  if (!item) return 'empty';
  if (item.kind === 'tool_call_group') {
    return `tcg:${item.messages.map(getMessageSizeSignature).join('|')}`;
  }
  return getMessageSizeSignature(item.message);
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

interface UseVirtualMessageListOptions {
  groupedMessages: GroupedItem[];
  scrollContainerRef: React.RefObject<HTMLDivElement | null>;
  sessionId: string;
  onLoadMore: () => Promise<void> | void;
  showWaitingIndicator: boolean;
  hasActivePrompt: boolean;
}

interface UseVirtualMessageListResult {
  /** TanStack virtualizer instance */
  virtualizer: Virtualizer<HTMLDivElement, Element>;
  /** Whether the list is auto-scrolling to bottom */
  autoScroll: boolean;
  setAutoScroll: React.Dispatch<React.SetStateAction<boolean>>;
  /** Scroll handler to attach to the scroll container */
  handleScroll: () => void;
  /** Load-more wrapper that preserves scroll position */
  handleLoadMore: () => Promise<void>;
  /** Scroll to the bottom of the list */
  scrollToBottom: (behavior?: ScrollBehavior | 'instant') => void;
  /** Set of grouped-item keys that were just appended (for enter animation) */
  newItemKeys: ReadonlySet<string>;
}

export function useVirtualMessageList({
  groupedMessages,
  scrollContainerRef,
  sessionId,
  onLoadMore,
  showWaitingIndicator,
  hasActivePrompt,
}: UseVirtualMessageListOptions): UseVirtualMessageListResult {
  const [autoScroll, setAutoScroll] = useState(false);
  const hasInitializedRef = useRef(false);
  const prevScrollTopRef = useRef(0);
  const pendingInitialScrollFrameRef = useRef<number | null>(null);
  const pendingInitialScrollFollowupFrameRef = useRef<number | null>(null);
  const pendingAutoScrollFrameRef = useRef<number | null>(null);
  const pendingAutoScrollFollowupFrameRef = useRef<number | null>(null);
  const isRestoringInitialScrollRef = useRef(false);
  const prevAutoScrollTargetRef = useRef({
    count: groupedMessages.length,
    contentSignature: groupedMessages.map(getGroupedItemSizeSignature).join('||'),
  });
  const setScrollPosition = useChatStore((state) => state.setScrollPosition);

  // Track which keys are "new" (appended at the end) for enter animation.
  // Keys are added when the count grows at the tail and cleared after a short
  // timeout so the animation only plays once.
  const [newItemKeys, setNewItemKeys] = useState<ReadonlySet<string>>(new Set());

  // Detect newly appended items (at the tail) vs prepended (load-more)
  const prevCountRef = useRef(groupedMessages.length);
  const prevFirstKeyRef = useRef<string | null>(null);

  useEffect(() => {
    const prevCount = prevCountRef.current;
    const prevFirstKey = prevFirstKeyRef.current;
    const currentCount = groupedMessages.length;
    const currentFirstKey = currentCount > 0 ? getGroupedItemKey(groupedMessages[0]) : null;

    prevCountRef.current = currentCount;
    prevFirstKeyRef.current = currentFirstKey;

    if (currentCount <= prevCount) return; // shrunk or unchanged
    if (prevCount === 0) return; // initial load

    // If the first key changed, items were prepended (load-more) — no animation
    if (currentFirstKey !== prevFirstKey) return;

    // Items appended at the end — mark them as "new"
    const newKeys = new Set<string>();
    for (let i = prevCount; i < currentCount; i++) {
      newKeys.add(getGroupedItemKey(groupedMessages[i]));
    }
    if (newKeys.size > 0) {
      setNewItemKeys(newKeys);
      // Clear after animation duration (150ms) + buffer
      const timer = setTimeout(() => setNewItemKeys(new Set()), 300);
      return () => clearTimeout(timer);
    }
  }, [groupedMessages]);

  // -----------------------------------------------------------------------
  // Virtualizer
  // -----------------------------------------------------------------------

  const count = groupedMessages.length;
  const contentSizeSignature = useMemo(
    () => groupedMessages.map(getGroupedItemSizeSignature).join('||'),
    [groupedMessages],
  );

  const virtualizer = useVirtualizer({
    count,
    getScrollElement: () => scrollContainerRef.current,
    estimateSize: (index: number) => estimateGroupedItemHeight(groupedMessages[index]),
    overscan: 5,
    getItemKey: (index: number) => getGroupedItemKey(groupedMessages[index]),
    initialOffset: () => useChatStore.getState().getScrollPosition(sessionId) ?? 0,
  });

  // -----------------------------------------------------------------------
  // Scroll handling
  // -----------------------------------------------------------------------

  const pinToBottom = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container) return;

    const nextTop = Math.max(0, container.scrollHeight - container.clientHeight);
    if (Math.abs(container.scrollTop - nextTop) > 1) {
      container.scrollTop = nextTop;
    }
    prevScrollTopRef.current = container.scrollTop;
  }, [scrollContainerRef]);

  const restoreScrollTop = useCallback((scrollTop: number) => {
    const container = scrollContainerRef.current;
    if (!container) return 0;

    const maxScrollTop = Math.max(0, container.scrollHeight - container.clientHeight);
    const nextScrollTop = Math.max(0, Math.min(maxScrollTop, scrollTop));
    if (Math.abs(container.scrollTop - nextScrollTop) > 1) {
      container.scrollTop = nextScrollTop;
    }
    prevScrollTopRef.current = nextScrollTop;
    return nextScrollTop;
  }, [scrollContainerRef]);

  const cancelPendingInitialScroll = useCallback(() => {
    if (pendingInitialScrollFrameRef.current !== null) {
      cancelAnimationFrame(pendingInitialScrollFrameRef.current);
      pendingInitialScrollFrameRef.current = null;
    }
    if (pendingInitialScrollFollowupFrameRef.current !== null) {
      cancelAnimationFrame(pendingInitialScrollFollowupFrameRef.current);
      pendingInitialScrollFollowupFrameRef.current = null;
    }
    isRestoringInitialScrollRef.current = false;
  }, []);

  const cancelPendingAutoScroll = useCallback(() => {
    if (pendingAutoScrollFrameRef.current !== null) {
      cancelAnimationFrame(pendingAutoScrollFrameRef.current);
      pendingAutoScrollFrameRef.current = null;
    }
    if (pendingAutoScrollFollowupFrameRef.current !== null) {
      cancelAnimationFrame(pendingAutoScrollFollowupFrameRef.current);
      pendingAutoScrollFollowupFrameRef.current = null;
    }
  }, []);

  const scheduleAutoScrollToBottom = useCallback(() => {
    if (isRestoringInitialScrollRef.current) return;
    if (pendingAutoScrollFrameRef.current !== null) return;

    if (pendingAutoScrollFollowupFrameRef.current !== null) {
      cancelAnimationFrame(pendingAutoScrollFollowupFrameRef.current);
      pendingAutoScrollFollowupFrameRef.current = null;
    }

    pendingAutoScrollFrameRef.current = requestAnimationFrame(() => {
      pendingAutoScrollFrameRef.current = null;
      pinToBottom();

      // TanStack virtualizer can update measured row height after the first
      // layout pass. Correct once more so streaming markdown does not jump.
      pendingAutoScrollFollowupFrameRef.current = requestAnimationFrame(() => {
        pendingAutoScrollFollowupFrameRef.current = null;
        pinToBottom();
      });
    });
  }, [pinToBottom]);

  const scrollToBottom = useCallback((behavior: ScrollBehavior | 'instant' = 'smooth') => {
    const container = scrollContainerRef.current;
    if (!container) return;

    if (behavior === 'instant') {
      pinToBottom();
      return;
    }

    const top = Math.max(0, container.scrollHeight - container.clientHeight);
    container.scrollTo({ top, behavior });
  }, [pinToBottom, scrollContainerRef]);

  const handleScroll = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container) return;

    if (isRestoringInitialScrollRef.current) {
      prevScrollTopRef.current = container.scrollTop;
      return;
    }

    cancelPendingInitialScroll();

    const { scrollTop, scrollHeight, clientHeight } = container;
    const distanceFromBottom = scrollHeight - scrollTop - clientHeight;
    const previousScrollTop = prevScrollTopRef.current;
    prevScrollTopRef.current = scrollTop;

    setScrollPosition(sessionId, scrollTop);

    // Near bottom → enable auto-scroll
    if (distanceFromBottom < 30) {
      setAutoScroll(true);
      return;
    }

    // Scrolling up → disable
    if (scrollTop < previousScrollTop) {
      cancelPendingAutoScroll();
      setAutoScroll(false);
      return;
    }

    // Far from bottom → disable
    if (distanceFromBottom > 100) {
      cancelPendingAutoScroll();
      setAutoScroll(false);
    }
  }, [cancelPendingAutoScroll, cancelPendingInitialScroll, sessionId, setScrollPosition, scrollContainerRef]);

  // -----------------------------------------------------------------------
  // Initial scroll restore & auto-scroll on new messages / streaming growth
  // -----------------------------------------------------------------------

  useLayoutEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;

    if (!hasInitializedRef.current) {
      if (count > 0) {
        prevAutoScrollTargetRef.current = { count, contentSignature: contentSizeSignature };
        const savedPosition = useChatStore.getState().getScrollPosition(sessionId);
        if (savedPosition !== undefined) {
          isRestoringInitialScrollRef.current = true;
          const applySavedPosition = () => {
            const appliedScrollTop = restoreScrollTop(savedPosition);
            const maxScrollTop = Math.max(0, container.scrollHeight - container.clientHeight);
            const shouldAutoScroll =
              maxScrollTop > 0
                ? maxScrollTop - appliedScrollTop < 30
                : savedPosition <= 1;
            setAutoScroll(shouldAutoScroll);
            return shouldAutoScroll;
          };

          applySavedPosition();
          pendingInitialScrollFrameRef.current = requestAnimationFrame(() => {
            pendingInitialScrollFrameRef.current = null;
            applySavedPosition();

            pendingInitialScrollFollowupFrameRef.current = requestAnimationFrame(() => {
              pendingInitialScrollFollowupFrameRef.current = null;
              const shouldAutoScroll = applySavedPosition();
              isRestoringInitialScrollRef.current = false;
              if (shouldAutoScroll) {
                scheduleAutoScrollToBottom();
              }
            });
          });
        } else {
          scrollToBottom('instant');
          pendingInitialScrollFrameRef.current = requestAnimationFrame(() => {
            pendingInitialScrollFrameRef.current = null;
            scrollToBottom('instant');
          });
          setAutoScroll(true);
        }
        hasInitializedRef.current = true;
      }
      return;
    }

    const previous = prevAutoScrollTargetRef.current;
    prevAutoScrollTargetRef.current = { count, contentSignature: contentSizeSignature };

    const contentChanged =
      count !== previous.count || contentSizeSignature !== previous.contentSignature;
    if (autoScroll && contentChanged) {
      scheduleAutoScrollToBottom();
    }
  }, [autoScroll, count, contentSizeSignature, restoreScrollTop, scheduleAutoScrollToBottom, scrollToBottom, sessionId, scrollContainerRef]);

  // Keep at bottom when waiting indicator or interactive prompt appears
  useEffect(() => {
    if (autoScroll) {
      scheduleAutoScrollToBottom();
    }
  }, [autoScroll, showWaitingIndicator, scheduleAutoScrollToBottom]);

  useEffect(() => {
    if (autoScroll) {
      scheduleAutoScrollToBottom();
    }
  }, [autoScroll, hasActivePrompt, scheduleAutoScrollToBottom]);

  useEffect(() => {
    return () => {
      cancelPendingInitialScroll();
      cancelPendingAutoScroll();
    };
  }, [cancelPendingAutoScroll, cancelPendingInitialScroll]);

  // -----------------------------------------------------------------------
  // Load-more with scroll anchoring
  // -----------------------------------------------------------------------

  const handleLoadMore = useCallback(async () => {
    const container = scrollContainerRef.current;
    const previousScrollHeight = container?.scrollHeight ?? 0;
    const previousScrollTop = container?.scrollTop ?? 0;

    await onLoadMore();

    // After new items are prepended, the virtualizer recalculates totalSize.
    // Adjust scrollTop by the delta so the user's viewport stays in place.
    requestAnimationFrame(() => {
      if (!container) return;
      const nextScrollHeight = container.scrollHeight;
      container.scrollTop = previousScrollTop + (nextScrollHeight - previousScrollHeight);
    });
  }, [onLoadMore, scrollContainerRef]);

  return {
    virtualizer,
    autoScroll,
    setAutoScroll,
    handleScroll,
    handleLoadMore,
    scrollToBottom,
    newItemKeys,
  };
}
