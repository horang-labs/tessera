'use client';

import { useEffect, useState } from 'react';
import {
  selectShouldShowWaitingIndicator,
  useChatStore,
} from '@/stores/chat-store';
import type { EnhancedMessage } from '@/types/chat';

/** Delay (ms) before showing the indicator to avoid flickering during brief gaps */
const SHOW_DELAY_MS = 400;

/**
 * Determines whether the waiting indicator should be shown.
 *
 * Shows the indicator whenever this session's turn is active, except while a
 * text chunk is buffered and about to render as assistant text.
 *
 * Intentionally does NOT hide during thinking streaming, tool execution,
 * or MCP progress: those are exactly the silent gaps that previously made
 * the chat feel frozen.
 *
 * A debounce delay is applied to the false→true transition to prevent
 * flickering during rapid tool-call gaps.
 */
export function useShowWaitingIndicator(
  sessionId: string,
  _messages: EnhancedMessage[]
): boolean {
  const shouldShow = useChatStore(selectShouldShowWaitingIndicator(sessionId));

  // Debounce: delay showing (false→true) to avoid flicker, hide immediately (true→false)
  const [debouncedShow, setDebouncedShow] = useState(false);

  useEffect(() => {
    if (!shouldShow) {
      const frameId = requestAnimationFrame(() => setDebouncedShow(false));
      return () => cancelAnimationFrame(frameId);
    }

    const resetFrameId = requestAnimationFrame(() => setDebouncedShow(false));
    const timer = setTimeout(() => setDebouncedShow(true), SHOW_DELAY_MS);

    return () => {
      cancelAnimationFrame(resetFrameId);
      clearTimeout(timer);
    };
  }, [shouldShow]);

  return debouncedShow;
}
