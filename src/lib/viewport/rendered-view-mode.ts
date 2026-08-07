'use client';

import { useBoardStore, type ViewMode } from '@/stores/board-store';
import { isPhoneViewport } from './phone-viewport';

/**
 * The view mode on screen, as opposed to the one that is stored.
 *
 * A Phone viewport renders the list whatever is stored, because the kanban
 * board is unusable at that width. The stored value is never written here — a
 * user who opens Tessera on a phone once must not find their desktop board gone
 * later, on a device they are not looking at.
 *
 * The rule lives here rather than in the hook because the callers that route a
 * tap — a toast, a notification, a file open — read the store imperatively and
 * have no hook to read. If they asked the store directly they would send taps
 * to a board peek the phone is not rendering, and the tap would do nothing.
 */
export function resolveRenderedViewMode(
  storedViewMode: ViewMode,
  isPhoneViewportNow: boolean,
): ViewMode {
  return isPhoneViewportNow ? 'list' : storedViewMode;
}

/** The same answer for callers outside React. Reactive callers use `useEffectiveViewMode`. */
export function getRenderedViewMode(): ViewMode {
  return resolveRenderedViewMode(useBoardStore.getState().viewMode, isPhoneViewport());
}
