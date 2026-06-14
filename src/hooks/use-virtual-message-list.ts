'use client';

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer, type Virtualizer } from '@tanstack/react-virtual';
import type { AgentBlockGroupItem, GroupedItem } from '@/lib/chat/group-messages';
import {
  useChatStore,
  type ScrollPositionSnapshot,
} from '@/stores/chat-store';
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
          return height + 16 + estimateContentBodyHeight(groupItem.message.content);
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
      return 64 + estimateContentBodyHeight(msg.content);
    }
    default:
      return 80;
  }
}

function estimateGroupedListHeight(groupedMessages: GroupedItem[]): number {
  return groupedMessages.reduce(
    (height, item) => height + estimateGroupedItemHeight(item),
    0,
  );
}

function estimateContentBodyHeight(content: unknown): number {
  if (typeof content === 'string') {
    return estimateMarkdownTextHeight(content);
  }

  if (Array.isArray(content)) {
    return content.reduce((height, block) => {
      if (!block || typeof block !== 'object') return height;
      const record = block as Record<string, unknown>;
      if (record.type === 'text') {
        return height + estimateMarkdownTextHeight(String(record.text ?? ''));
      }
      if (record.type === 'image') {
        return height + 220;
      }
      return height;
    }, 0);
  }

  return 24;
}

function estimateMarkdownTextHeight(content: string): number {
  if (!content.trim()) return 24;

  const lines = content.split('\n');
  let visualLines = 0;
  let fenceMarkers = 0;
  let tableLikeLines = 0;
  let listLikeLines = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    visualLines += Math.max(1, Math.ceil(line.length / 88));

    if (trimmed.startsWith('```')) {
      fenceMarkers++;
    }
    if (trimmed.includes('|')) {
      tableLikeLines++;
    }
    if (/^([-*+]|\d+\.)\s+/.test(trimmed)) {
      listLikeLines++;
    }
  }

  const fencedBlockCount = Math.floor(fenceMarkers / 2);
  const markdownBlockExtra =
    fencedBlockCount * 52 +
    Math.min(tableLikeLines, 16) * 4 +
    Math.min(listLikeLines, 24) * 2;

  return Math.max(24, visualLines * 21 + markdownBlockExtra);
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

const NEAR_BOTTOM_THRESHOLD_PX = 30;
const FAR_FROM_BOTTOM_THRESHOLD_PX = 100;
const SCROLL_RESTORE_EPSILON_PX = 1;
const RESTORE_MAX_FRAMES = 60;
const RESTORE_STABLE_FRAMES = 2;

function getDistanceFromBottom(container: HTMLDivElement): number {
  return Math.max(0, container.scrollHeight - container.scrollTop - container.clientHeight);
}

function getMaxScrollTop(container: HTMLDivElement): number {
  return Math.max(0, container.scrollHeight - container.clientHeight);
}

function clampScrollTop(container: HTMLDivElement, scrollTop: number): number {
  return Math.max(0, Math.min(getMaxScrollTop(container), scrollTop));
}

function getTailSignature(groupedMessages: GroupedItem[]): string {
  return getGroupedItemSizeSignature(groupedMessages[groupedMessages.length - 1]);
}

function isBrowserDocumentHidden(): boolean {
  return typeof document !== 'undefined' && document.visibilityState === 'hidden';
}

function findRowByItemKey(container: HTMLDivElement, itemKey: string): HTMLElement | null {
  const rowElements = Array.from(
    container.querySelectorAll<HTMLElement>('[data-item-key]'),
  );
  return rowElements.find((element) => element.dataset.itemKey === itemKey) ?? null;
}

function canCaptureScrollPosition(container: HTMLDivElement): boolean {
  return container.isConnected && container.clientHeight > 0 && container.scrollHeight > 0;
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
  isTabActive?: boolean;
  isTurnInFlight?: boolean;
}

interface UseVirtualMessageListResult {
  /** TanStack virtualizer instance */
  virtualizer: Virtualizer<HTMLDivElement, Element>;
  /** Whether the list is auto-scrolling to bottom */
  autoScroll: boolean;
  setAutoScroll: React.Dispatch<React.SetStateAction<boolean>>;
  /** Scroll handler to attach to the scroll container */
  handleScroll: () => void;
  /** Wheel handler used to cancel bottom pinning before the scroll event lands */
  handleWheel: (event: React.WheelEvent<HTMLDivElement>) => void;
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
  isTabActive = true,
  isTurnInFlight = false,
}: UseVirtualMessageListOptions): UseVirtualMessageListResult {
  const isViewActive = isTabActive;
  const [autoScroll, setAutoScroll] = useState(false);
  const hasInitializedRef = useRef(false);
  const prevScrollTopRef = useRef(0);
  const pendingBottomRestoreFrameRef = useRef<number | null>(null);
  const pendingSnapshotRestoreFrameRef = useRef<number | null>(null);
  const isRestoringInitialScrollRef = useRef(false);
  const isUserScrollingRef = useRef(false);
  const userLockedAwayFromBottomRef = useRef(false);
  const wasViewActiveRef = useRef(isViewActive);
  const isViewActiveRef = useRef(isViewActive);
  const forceBottomOnNextResumeRef = useRef(false);
  const userScrollEndTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevAutoScrollTargetRef = useRef({
    count: groupedMessages.length,
    contentSignature: groupedMessages.map(getGroupedItemSizeSignature).join('||'),
  });
  const prevTotalSizeRef = useRef(0);
  const setScrollPosition = useChatStore((state) => state.setScrollPosition);
  const getScrollPosition = useChatStore((state) => state.getScrollPosition);
  const lastGoodScrollPositionRef = useRef<ScrollPositionSnapshot | null>(
    getScrollPosition(sessionId) ?? null,
  );

  isViewActiveRef.current = isViewActive;

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
  const tailSignature = useMemo(
    () => getTailSignature(groupedMessages),
    [groupedMessages],
  );
  const estimatedListHeight = useMemo(
    () => estimateGroupedListHeight(groupedMessages),
    [groupedMessages],
  );
  const shouldRestoreToBottom = useCallback((snapshot: ScrollPositionSnapshot | undefined) => (
    forceBottomOnNextResumeRef.current ||
    !snapshot ||
    snapshot.isAtBottom === true ||
    snapshot.capturedDuringTurn === true
  ), []);

  const virtualizer = useVirtualizer({
    count,
    getScrollElement: () => scrollContainerRef.current,
    estimateSize: (index: number) => estimateGroupedItemHeight(groupedMessages[index]),
    overscan: 5,
    getItemKey: (index: number) => getGroupedItemKey(groupedMessages[index]),
    initialOffset: () => {
      const savedPosition = getScrollPosition(sessionId);
      const viewportHeight = scrollContainerRef.current?.clientHeight ?? 0;
      if (savedPosition && !shouldRestoreToBottom(savedPosition)) {
        return Math.max(0, savedPosition.scrollTop);
      }
      return Math.max(0, estimatedListHeight - viewportHeight);
    },
    useAnimationFrameWithResizeObserver: true,
  });

  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = (item, _delta, instance) => {
    if (isUserScrollingRef.current && !autoScroll) {
      return false;
    }

    const virtualizerState = instance as unknown as {
      getScrollOffset?: () => number;
      scrollAdjustments?: number;
      scrollOffset?: number | null;
    };
    const scrollOffset = virtualizerState.getScrollOffset?.() ?? virtualizerState.scrollOffset ?? 0;
    const scrollAdjustments = virtualizerState.scrollAdjustments ?? 0;
    const anchor = scrollOffset + scrollAdjustments;

    // Following the live tail: keep the bottom pinned by compensating for any
    // item above the offset as new content streams in.
    if (autoScroll) {
      return item.start < anchor;
    }

    // Parked away from the bottom — the user is reading. Only compensate when the
    // changed item sits ENTIRELY above the viewport top (genuine re-layout of
    // already-read content: images decoding, code highlighting). A streaming
    // message that straddles the viewport top grows at its tail, below the read
    // position; adjusting scroll there would shove the read text upward out of
    // view. `item` carries the pre-growth measurement, so `item.end` is the old
    // bottom edge — leave straddling (and below-viewport) items untouched.
    return item.end <= anchor;
  };

  const totalSize = virtualizer.getTotalSize();

  const captureScrollPosition = useCallback((container: HTMLDivElement): ScrollPositionSnapshot => {
    const scrollTop = container.scrollTop;
    const distanceFromBottom = getDistanceFromBottom(container);
    const baseSnapshot: ScrollPositionSnapshot = {
      scrollTop,
      distanceFromBottom,
      isAtBottom: distanceFromBottom <= NEAR_BOTTOM_THRESHOLD_PX,
      itemCount: count,
      tailSignature,
      capturedDuringTurn:
        isTurnInFlight &&
        !userLockedAwayFromBottomRef.current &&
        distanceFromBottom <= NEAR_BOTTOM_THRESHOLD_PX,
    };
    const containerTop = container.getBoundingClientRect().top;
    const rowElements = Array.from(
      container.querySelectorAll<HTMLElement>('[data-index]'),
    );
    const anchorElement =
      rowElements.find((element) => element.getBoundingClientRect().bottom > containerTop + 1)
      ?? rowElements[0];

    if (!anchorElement) {
      return baseSnapshot;
    }

    const index = Number(anchorElement.dataset.index);
    const item = Number.isFinite(index) ? groupedMessages[index] : undefined;
    if (!item) {
      return baseSnapshot;
    }

    return {
      ...baseSnapshot,
      anchorKey: anchorElement.dataset.itemKey ?? getGroupedItemKey(item),
      anchorOffset: Math.max(0, containerTop - anchorElement.getBoundingClientRect().top),
    };
  }, [count, groupedMessages, isTurnInFlight, tailSignature]);

  // -----------------------------------------------------------------------
  // Scroll handling
  // -----------------------------------------------------------------------

  const pinToBottom = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container) return;

    const nextTop = getMaxScrollTop(container);
    if (Math.abs(container.scrollTop - nextTop) > 1) {
      container.scrollTop = nextTop;
    }
    prevScrollTopRef.current = container.scrollTop;
  }, [scrollContainerRef]);

  const cancelPendingRestores = useCallback(() => {
    if (pendingBottomRestoreFrameRef.current !== null) {
      cancelAnimationFrame(pendingBottomRestoreFrameRef.current);
      pendingBottomRestoreFrameRef.current = null;
    }
    if (pendingSnapshotRestoreFrameRef.current !== null) {
      cancelAnimationFrame(pendingSnapshotRestoreFrameRef.current);
      pendingSnapshotRestoreFrameRef.current = null;
    }
    isRestoringInitialScrollRef.current = false;
  }, []);

  const setAutoScrollFromCaller = useCallback<React.Dispatch<React.SetStateAction<boolean>>>((value) => {
    setAutoScroll((previous) => {
      const next = typeof value === 'function'
        ? (value as (previous: boolean) => boolean)(previous)
        : value;
      if (next) {
        userLockedAwayFromBottomRef.current = false;
      }
      return next;
    });
  }, []);

  const markUserScrolling = useCallback(() => {
    isUserScrollingRef.current = true;
    if (userScrollEndTimerRef.current !== null) {
      clearTimeout(userScrollEndTimerRef.current);
    }
    userScrollEndTimerRef.current = setTimeout(() => {
      userScrollEndTimerRef.current = null;
      isUserScrollingRef.current = false;
    }, 180);
  }, []);

  const storeGoodScrollPosition = useCallback((snapshot: ScrollPositionSnapshot) => {
    lastGoodScrollPositionRef.current = snapshot;
    setScrollPosition(sessionId, snapshot);
  }, [sessionId, setScrollPosition]);

  const flushLastGoodScrollPosition = useCallback(() => {
    const snapshot = lastGoodScrollPositionRef.current;
    if (snapshot) {
      setScrollPosition(sessionId, snapshot);
    }
  }, [sessionId, setScrollPosition]);

  const captureAndStoreGoodScrollPosition = useCallback((container: HTMLDivElement) => {
    if (!isViewActiveRef.current || isBrowserDocumentHidden()) return false;
    if (!canCaptureScrollPosition(container)) return false;

    storeGoodScrollPosition(captureScrollPosition(container));
    return true;
  }, [captureScrollPosition, storeGoodScrollPosition]);

  const disableAutoScrollFromUser = useCallback((container: HTMLDivElement) => {
    userLockedAwayFromBottomRef.current = true;
    forceBottomOnNextResumeRef.current = false;
    cancelPendingRestores();
    setAutoScroll(false);
    captureAndStoreGoodScrollPosition(container);
  }, [cancelPendingRestores, captureAndStoreGoodScrollPosition]);

  const markBottomOnNextResume = useCallback(() => {
    if (userLockedAwayFromBottomRef.current) return;

    forceBottomOnNextResumeRef.current = true;
    const snapshot = lastGoodScrollPositionRef.current;
    if (snapshot) {
      const nextSnapshot = {
        ...snapshot,
        capturedDuringTurn: true,
      };
      lastGoodScrollPositionRef.current = nextSnapshot;
      setScrollPosition(sessionId, nextSnapshot);
    }
  }, [sessionId, setScrollPosition]);

  const rememberCurrentScrollPosition = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container || isRestoringInitialScrollRef.current) {
      flushLastGoodScrollPosition();
      return;
    }
    if (!captureAndStoreGoodScrollPosition(container)) {
      flushLastGoodScrollPosition();
    }
  }, [captureAndStoreGoodScrollPosition, flushLastGoodScrollPosition, scrollContainerRef]);
  const rememberCurrentScrollPositionRef = useRef(rememberCurrentScrollPosition);

  useEffect(() => {
    rememberCurrentScrollPositionRef.current = rememberCurrentScrollPosition;
  }, [rememberCurrentScrollPosition]);

  const restoreSnapshotPosition = useCallback((snapshot: ScrollPositionSnapshot) => {
    const container = scrollContainerRef.current;
    if (!container) return null;

    let nextTop = snapshot.scrollTop;
    let anchorFound = false;
    if (snapshot.anchorKey) {
      const anchorElement = findRowByItemKey(container, snapshot.anchorKey);
      if (anchorElement) {
        anchorFound = true;
        const containerTop = container.getBoundingClientRect().top;
        const anchorTop = anchorElement.getBoundingClientRect().top;
        nextTop = container.scrollTop + anchorTop - containerTop + (snapshot.anchorOffset ?? 0);
      }
    }

    const clampedTop = clampScrollTop(container, nextTop);
    if (Math.abs(container.scrollTop - clampedTop) > SCROLL_RESTORE_EPSILON_PX) {
      container.scrollTop = clampedTop;
    }
    prevScrollTopRef.current = container.scrollTop;

    return {
      anchorFound: anchorFound || !snapshot.anchorKey,
      scrollHeight: container.scrollHeight,
      scrollTop: container.scrollTop,
      maxScrollTop: getMaxScrollTop(container),
    };
  }, [scrollContainerRef]);

  const isSnapshotRestoreComplete = useCallback((
    snapshot: ScrollPositionSnapshot,
    result: { anchorFound: boolean; scrollTop: number; maxScrollTop: number },
  ) => {
    if (result.anchorFound) return true;
    if (snapshot.scrollTop <= SCROLL_RESTORE_EPSILON_PX) return true;
    if (result.maxScrollTop + SCROLL_RESTORE_EPSILON_PX < snapshot.scrollTop) {
      return false;
    }
    return Math.abs(result.scrollTop - snapshot.scrollTop) <= SCROLL_RESTORE_EPSILON_PX;
  }, []);

  const scheduleBottomRestore = useCallback((options: { clearForce?: boolean; storePosition?: boolean } = {}) => {
    const container = scrollContainerRef.current;
    if (!container) return;

    cancelPendingRestores();
    isRestoringInitialScrollRef.current = true;
    setAutoScroll(true);

    let attempt = 0;
    let stableFrames = 0;
    let lastScrollHeight = -1;
    let lastScrollTop = -1;

    const runFrame = () => {
      pendingBottomRestoreFrameRef.current = null;
      const currentContainer = scrollContainerRef.current;
      if (!currentContainer) {
        isRestoringInitialScrollRef.current = false;
        return;
      }
      if (userLockedAwayFromBottomRef.current) {
        isRestoringInitialScrollRef.current = false;
        return;
      }

      pinToBottom();
      const distanceFromBottom = getDistanceFromBottom(currentContainer);
      const isStable =
        Math.abs(currentContainer.scrollTop - lastScrollTop) <= SCROLL_RESTORE_EPSILON_PX &&
        Math.abs(currentContainer.scrollHeight - lastScrollHeight) <= SCROLL_RESTORE_EPSILON_PX &&
        distanceFromBottom <= SCROLL_RESTORE_EPSILON_PX;

      stableFrames = isStable ? stableFrames + 1 : 0;
      lastScrollTop = currentContainer.scrollTop;
      lastScrollHeight = currentContainer.scrollHeight;
      attempt += 1;

      if (stableFrames >= RESTORE_STABLE_FRAMES || attempt >= RESTORE_MAX_FRAMES) {
        isRestoringInitialScrollRef.current = false;
        prevScrollTopRef.current = currentContainer.scrollTop;
        if (options.clearForce) forceBottomOnNextResumeRef.current = false;
        if (options.storePosition) {
          captureAndStoreGoodScrollPosition(currentContainer);
        }
        return;
      }

      pendingBottomRestoreFrameRef.current = requestAnimationFrame(runFrame);
    };

    runFrame();
  }, [cancelPendingRestores, captureAndStoreGoodScrollPosition, pinToBottom, scrollContainerRef]);

  const scheduleSnapshotRestore = useCallback((snapshot: ScrollPositionSnapshot, options: { storePosition?: boolean } = {}) => {
    const container = scrollContainerRef.current;
    if (!container) return;

    cancelPendingRestores();
    isRestoringInitialScrollRef.current = true;
    setAutoScroll(false);

    let attempt = 0;
    let stableFrames = 0;
    let lastScrollHeight = -1;
    let lastScrollTop = -1;
    let lastRestoreComplete = false;

    const runFrame = () => {
      pendingSnapshotRestoreFrameRef.current = null;
      const currentContainer = scrollContainerRef.current;
      if (!currentContainer) {
        isRestoringInitialScrollRef.current = false;
        return;
      }

      const result = restoreSnapshotPosition(snapshot);
      if (!result) {
        isRestoringInitialScrollRef.current = false;
        return;
      }

      const restoreComplete = isSnapshotRestoreComplete(snapshot, result);
      lastRestoreComplete = restoreComplete;
      const isStable =
        restoreComplete &&
        Math.abs(result.scrollTop - lastScrollTop) <= SCROLL_RESTORE_EPSILON_PX &&
        Math.abs(result.scrollHeight - lastScrollHeight) <= SCROLL_RESTORE_EPSILON_PX;

      stableFrames = isStable ? stableFrames + 1 : 0;
      lastScrollTop = result.scrollTop;
      lastScrollHeight = result.scrollHeight;
      attempt += 1;

      if (stableFrames >= RESTORE_STABLE_FRAMES || attempt >= RESTORE_MAX_FRAMES) {
        isRestoringInitialScrollRef.current = false;
        prevScrollTopRef.current = currentContainer.scrollTop;
        const isAtBottom = getDistanceFromBottom(currentContainer) <= NEAR_BOTTOM_THRESHOLD_PX;
        setAutoScroll(isAtBottom);
        if (options.storePosition && lastRestoreComplete) {
          captureAndStoreGoodScrollPosition(currentContainer);
        }
        return;
      }

      pendingSnapshotRestoreFrameRef.current = requestAnimationFrame(runFrame);
    };

    runFrame();
  }, [cancelPendingRestores, captureAndStoreGoodScrollPosition, isSnapshotRestoreComplete, restoreSnapshotPosition, scrollContainerRef]);

  const scheduleAutoScrollToBottom = useCallback(() => {
    if (userLockedAwayFromBottomRef.current) return;
    if (pendingSnapshotRestoreFrameRef.current !== null) return;
    scheduleBottomRestore({ storePosition: true });
  }, [scheduleBottomRestore]);

  const scrollToBottom = useCallback((behavior: ScrollBehavior | 'instant' = 'smooth') => {
    const container = scrollContainerRef.current;
    if (!container) return;

    if (behavior === 'instant') {
      userLockedAwayFromBottomRef.current = false;
      scheduleBottomRestore({ storePosition: true });
      return;
    }

    cancelPendingRestores();
    userLockedAwayFromBottomRef.current = false;
    setAutoScroll(true);
    const top = getMaxScrollTop(container);
    container.scrollTo({ top, behavior });
  }, [cancelPendingRestores, scheduleBottomRestore, scrollContainerRef]);

  const handleScroll = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container) return;

    if (!isViewActive || isBrowserDocumentHidden()) {
      if (isTurnInFlight) {
        markBottomOnNextResume();
      }
      return;
    }

    const { scrollTop } = container;
    const distanceFromBottom = getDistanceFromBottom(container);
    const previousScrollTop = prevScrollTopRef.current;

    if (isRestoringInitialScrollRef.current) {
      const userMovedAwayDuringRestore =
        distanceFromBottom > NEAR_BOTTOM_THRESHOLD_PX &&
        (isUserScrollingRef.current || scrollTop < previousScrollTop);
      if (userMovedAwayDuringRestore) {
        prevScrollTopRef.current = scrollTop;
        disableAutoScrollFromUser(container);
        return;
      }
      prevScrollTopRef.current = scrollTop;
      return;
    }

    cancelPendingRestores();

    prevScrollTopRef.current = scrollTop;

    captureAndStoreGoodScrollPosition(container);

    // User intent wins even if the viewport is still technically near bottom.
    if (scrollTop < previousScrollTop) {
      disableAutoScrollFromUser(container);
      return;
    }

    // Near bottom → enable auto-scroll
    if (distanceFromBottom < NEAR_BOTTOM_THRESHOLD_PX) {
      userLockedAwayFromBottomRef.current = false;
      setAutoScroll(true);
      return;
    }

    // Far from bottom → disable
    if (distanceFromBottom > FAR_FROM_BOTTOM_THRESHOLD_PX) {
      disableAutoScrollFromUser(container);
    }
  }, [cancelPendingRestores, captureAndStoreGoodScrollPosition, disableAutoScrollFromUser, isTurnInFlight, isViewActive, markBottomOnNextResume, scrollContainerRef]);

  const handleWheel = useCallback((event: React.WheelEvent<HTMLDivElement>) => {
    const container = scrollContainerRef.current;
    if (!container) return;
    if (!isViewActive || isBrowserDocumentHidden()) return;

    markUserScrolling();

    const distanceFromBottom = getDistanceFromBottom(container);
    if (event.deltaY < 0 || distanceFromBottom > NEAR_BOTTOM_THRESHOLD_PX) {
      disableAutoScrollFromUser(container);
    }
  }, [disableAutoScrollFromUser, isViewActive, markUserScrolling, scrollContainerRef]);

  // -----------------------------------------------------------------------
  // Initial bottom pin & auto-scroll on new messages / streaming growth
  // -----------------------------------------------------------------------

  useLayoutEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    const canRunActiveScrollEffect = isViewActive && !isBrowserDocumentHidden();

    if (!hasInitializedRef.current) {
      if (count > 0) {
        prevAutoScrollTargetRef.current = { count, contentSignature: contentSizeSignature };
        prevTotalSizeRef.current = totalSize;
        hasInitializedRef.current = true;
        if (!canRunActiveScrollEffect) {
          return;
        }
        const savedPosition = getScrollPosition(sessionId);
        if (!savedPosition || shouldRestoreToBottom(savedPosition)) {
          scheduleBottomRestore({ clearForce: true, storePosition: true });
        } else {
          scheduleSnapshotRestore(savedPosition, { storePosition: true });
        }
      }
      return;
    }

    const previous = prevAutoScrollTargetRef.current;
    prevAutoScrollTargetRef.current = { count, contentSignature: contentSizeSignature };
    const previousTotalSize = prevTotalSizeRef.current;
    prevTotalSizeRef.current = totalSize;

    const contentChanged =
      count !== previous.count ||
      contentSizeSignature !== previous.contentSignature ||
      Math.abs(totalSize - previousTotalSize) > SCROLL_RESTORE_EPSILON_PX;
    if (isTurnInFlight && !canRunActiveScrollEffect && contentChanged) {
      markBottomOnNextResume();
    }
    if (autoScroll && canRunActiveScrollEffect && contentChanged) {
      scheduleAutoScrollToBottom();
    }
  }, [autoScroll, count, contentSizeSignature, getScrollPosition, isTurnInFlight, isViewActive, markBottomOnNextResume, scheduleAutoScrollToBottom, scheduleBottomRestore, scheduleSnapshotRestore, scrollContainerRef, sessionId, shouldRestoreToBottom, totalSize]);

  // Keep at bottom when waiting indicator or interactive prompt appears
  useEffect(() => {
    if (autoScroll && isViewActive && !isBrowserDocumentHidden()) {
      scheduleAutoScrollToBottom();
    }
  }, [autoScroll, isViewActive, showWaitingIndicator, scheduleAutoScrollToBottom]);

  useEffect(() => {
    if (autoScroll && isViewActive && !isBrowserDocumentHidden()) {
      scheduleAutoScrollToBottom();
    }
  }, [autoScroll, hasActivePrompt, isViewActive, scheduleAutoScrollToBottom]);

  useEffect(() => {
    if (isTurnInFlight && (!isViewActive || isBrowserDocumentHidden())) {
      markBottomOnNextResume();
    }
  }, [isTurnInFlight, isViewActive, markBottomOnNextResume]);

  useLayoutEffect(() => {
    const wasViewActive = wasViewActiveRef.current;
    if (wasViewActive && !isViewActive) {
      rememberCurrentScrollPosition();
      if (isTurnInFlight) {
        markBottomOnNextResume();
      }
      cancelPendingRestores();
    }

    if (!isViewActive || wasViewActive || !hasInitializedRef.current || count === 0) {
      wasViewActiveRef.current = isViewActive;
      return;
    }

    wasViewActiveRef.current = isViewActive;
    const savedPosition = getScrollPosition(sessionId);
    if (!savedPosition || shouldRestoreToBottom(savedPosition)) {
      scheduleBottomRestore({ clearForce: true, storePosition: true });
    } else {
      scheduleSnapshotRestore(savedPosition, { storePosition: true });
    }
  }, [cancelPendingRestores, count, getScrollPosition, isTurnInFlight, isViewActive, markBottomOnNextResume, rememberCurrentScrollPosition, scheduleBottomRestore, scheduleSnapshotRestore, sessionId, shouldRestoreToBottom]);

  useEffect(() => {
    if (typeof document === 'undefined') return;

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        rememberCurrentScrollPosition();
        if (isTurnInFlight) {
          markBottomOnNextResume();
        }
        return;
      }

      if (document.visibilityState !== 'visible') return;
      if (!isViewActive || !hasInitializedRef.current || count === 0) return;

      const savedPosition = getScrollPosition(sessionId);
      if (!savedPosition || shouldRestoreToBottom(savedPosition)) {
        scheduleBottomRestore({ clearForce: true, storePosition: true });
      } else {
        scheduleSnapshotRestore(savedPosition, { storePosition: true });
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [count, getScrollPosition, isTurnInFlight, isViewActive, markBottomOnNextResume, rememberCurrentScrollPosition, scheduleBottomRestore, scheduleSnapshotRestore, sessionId, shouldRestoreToBottom]);

  useEffect(() => {
    return () => {
      rememberCurrentScrollPositionRef.current();
      cancelPendingRestores();
      if (userScrollEndTimerRef.current !== null) {
        clearTimeout(userScrollEndTimerRef.current);
        userScrollEndTimerRef.current = null;
      }
    };
  }, [cancelPendingRestores]);

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
      prevScrollTopRef.current = container.scrollTop;
      captureAndStoreGoodScrollPosition(container);
    });
  }, [captureAndStoreGoodScrollPosition, onLoadMore, scrollContainerRef]);

  return {
    virtualizer,
    autoScroll,
    setAutoScroll: setAutoScrollFromCaller,
    handleScroll,
    handleWheel,
    handleLoadMore,
    scrollToBottom,
    newItemKeys,
  };
}
