'use client';

import { useBoardStore, type ViewMode } from '@/stores/board-store';
import { usePhoneViewport } from '@/hooks/use-phone-viewport';
import { resolveRenderedViewMode } from '@/lib/viewport/rendered-view-mode';

/**
 * The view mode to render, as opposed to the one that is stored — the reactive
 * way to ask `resolveRenderedViewMode`, which is where the rule and its reasons
 * live. `KanbanBoard` is a `dynamic()` import, so an unmet condition here means
 * the bundle is never fetched either.
 *
 * Anything that persists (sidebar width is keyed by view mode) must keep
 * reading the store, not this.
 */
export function useEffectiveViewMode(): ViewMode {
  const viewMode = useBoardStore((state) => state.viewMode);
  return resolveRenderedViewMode(viewMode, usePhoneViewport());
}
