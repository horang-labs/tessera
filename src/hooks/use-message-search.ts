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

function clampMatchIndex(index: number, matchCount: number): number {
  if (matchCount === 0) return 0;
  return Math.min(index, matchCount - 1);
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
    () =>
      findMessageSearchMatches(messages, query).filter(
        (match) =>
          findGroupedRowIndexForMessage(groupedMessages, match.messageId) >= 0,
      ),
    [messages, groupedMessages, query],
  );

  // Reset ephemeral search UI when the panel switches to a different session.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    setQuery('');
    setActiveMatchIndex(0);
    setIsSearchOpen(false);
  }, [sessionId]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const safeActiveMatchIndex = clampMatchIndex(
    activeMatchIndex,
    matches.length,
  );
  const activeMatch = matches[safeActiveMatchIndex] ?? null;
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
      if (matches.length === 0) {
        return 0;
      }
      return (clampMatchIndex(current, matches.length) + 1) % matches.length;
    });
  }, [matches.length]);

  const goToPreviousMatch = useCallback(() => {
    setActiveMatchIndex((current) => {
      if (matches.length === 0) {
        return 0;
      }
      return (clampMatchIndex(current, matches.length) - 1 + matches.length) % matches.length;
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
    activeMatchIndex: safeActiveMatchIndex,
    activeMatch,
    activeGroupedRowIndex,
    openSearch,
    closeSearch,
    setQuery: updateQuery,
    goToNextMatch,
    goToPreviousMatch,
  };
}
