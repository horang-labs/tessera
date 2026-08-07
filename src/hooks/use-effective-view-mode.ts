'use client';

import { useBoardStore, type ViewMode } from '@/stores/board-store';
import { usePhoneViewport } from '@/hooks/use-phone-viewport';

/**
 * The view mode to render, as opposed to the one that is stored.
 *
 * A Phone viewport renders the list whatever is stored: the kanban board is
 * unusable at that width, and `KanbanBoard` is a `dynamic()` import, so an
 * unmet condition means the bundle is never fetched either.
 *
 * The stored value is deliberately left alone — no `setViewMode` here. A user
 * who opens Tessera on a phone once must not find their desktop board gone
 * later, on a device they are not looking at, with nothing connecting the two
 * events. Anything that persists (sidebar width is keyed by view mode) must
 * therefore keep reading the store, not this.
 */
export function useEffectiveViewMode(): ViewMode {
  const viewMode = useBoardStore((state) => state.viewMode);
  const isPhoneViewport = usePhoneViewport();
  return isPhoneViewport ? 'list' : viewMode;
}
