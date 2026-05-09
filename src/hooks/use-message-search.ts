'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { EnhancedMessage } from '@/types/chat';
import type { GroupedItem } from '@/lib/chat/group-messages';
import {
  findGroupedRowIndexForMessage,
  findMessageSearchMatches,
  type MessageSearchMatch,
} from '@/lib/chat/message-search';

export interface UseMessageSearchResult {
  isSearchOpen: boolean;
  query: string;
  matches: MessageSearchMatch[];
  activeMatchIndex: number;
  activeMatch: MessageSearchMatch | null;
  activeGroupedRowIndex: number;
  openSearch: () => void;
  closeSearch: () => void;
  setQuery: (query: string) => void;
  goToNextMatch: () => void;
  goToPreviousMatch: () => void;
}

export function useMessageSearch(
  messages: EnhancedMessage[],
  groupedMessages: GroupedItem[],
  sessionId: string,
): UseMessageSearchResult {
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeMatchIndex, setActiveMatchIndex] = useState(0);

  const matches = useMemo(
    () => findMessageSearchMatches(messages, query),
    [messages, query],
  );

  useEffect(() => {
    setQuery('');
    setActiveMatchIndex(0);
    setIsSearchOpen(false);
  }, [sessionId]);

  useEffect(() => {
    setActiveMatchIndex((current) => {
      if (matches.length === 0) return 0;
      return Math.min(current, matches.length - 1);
    });
  }, [matches.length]);

  const activeMatch = matches[activeMatchIndex] ?? null;
  const activeGroupedRowIndex = activeMatch
    ? findGroupedRowIndexForMessage(groupedMessages, activeMatch.messageId)
    : -1;

  const openSearch = useCallback(() => {
    setIsSearchOpen(true);
  }, []);

  const closeSearch = useCallback(() => {
    setIsSearchOpen(false);
    setQuery('');
    setActiveMatchIndex(0);
  }, []);

  const goToNextMatch = useCallback(() => {
    setActiveMatchIndex((current) => {
      if (matches.length === 0) return 0;
      return (current + 1) % matches.length;
    });
  }, [matches.length]);

  const goToPreviousMatch = useCallback(() => {
    setActiveMatchIndex((current) => {
      if (matches.length === 0) return 0;
      return (current - 1 + matches.length) % matches.length;
    });
  }, [matches.length]);

  const updateQuery = useCallback((nextQuery: string) => {
    setQuery(nextQuery);
    setActiveMatchIndex(0);
  }, []);

  return {
    isSearchOpen,
    query,
    matches,
    activeMatchIndex,
    activeMatch,
    activeGroupedRowIndex,
    openSearch,
    closeSearch,
    setQuery: updateQuery,
    goToNextMatch,
    goToPreviousMatch,
  };
}
