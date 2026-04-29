'use client';

import { useState, useCallback } from 'react';
import { useChatStore } from '@/stores/chat-store';
import type { EnhancedMessage } from '@/types/chat';

interface WindowedMessagesResult {
  windowedMessages: EnhancedMessage[];
  hasMore: boolean;
  loadMore: () => Promise<void>;
  isLoadingMore: boolean;
  totalCount: number;
}

/**
 * Windowed messages hook.
 *
 * For sessions with pagination data (loaded via JSONL API): supports "load more".
 * For live-only sessions (no API history loaded): returns all messages as-is.
 */
export function useWindowedMessages(sessionId: string): WindowedMessagesResult {
  const [isLoadingMore, setIsLoadingMore] = useState(false);

  const allMessages = useChatStore(
    (state) => state.messages.get(sessionId)
  );
  const messages = allMessages ?? [];

  const pagination = useChatStore(
    (state) => state.readOnlyPagination.get(sessionId)
  );

  const loadMore = useCallback(async () => {
    if (isLoadingMore || !pagination?.hasMore) return;

    setIsLoadingMore(true);
    try {
      const params = new URLSearchParams({
        limit: '100',
        beforeBytes: String(pagination.nextBeforeBytes),
      });

      const response = await fetch(
        `/api/sessions/${sessionId}/messages?${params}`
      );

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const result = await response.json();

      // Prepend older messages (atomic — safe even if WebSocket appends during fetch)
      useChatStore.getState().prependHistory(sessionId, result.messages);

      // Update pagination state
      if (result.pagination) {
        useChatStore.getState().setReadOnlyPagination(sessionId, {
          projectDir: pagination.projectDir,
          hasMore: result.pagination.hasMore,
          nextBeforeBytes: result.pagination.nextBeforeBytes,
        });
      }
    } catch (err) {
      console.error('Failed to load more messages:', err);
    } finally {
      setIsLoadingMore(false);
    }
  }, [sessionId, isLoadingMore, pagination]);

  return {
    windowedMessages: messages,
    hasMore: pagination?.hasMore ?? false,
    loadMore,
    isLoadingMore,
    totalCount: messages.length,
  };
}
