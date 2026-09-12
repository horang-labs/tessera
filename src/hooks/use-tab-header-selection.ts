'use client';

import { useCallback, useMemo, useState } from 'react';
import { selectTabHeader, type TabHeaderSelection } from '@/lib/tab/tab-header-selection';

const EMPTY: TabHeaderSelection = { selectedTabIds: new Set(), anchorTabId: null };

export function useTabHeaderSelection(orderedTabIds: readonly string[], activeTabId: string, disabled: boolean) {
  const [state, setState] = useState<TabHeaderSelection>(EMPTY);
  const orderedIds = useMemo(() => orderedTabIds, [orderedTabIds]);
  const select = useCallback((tabId: string, mode: 'toggle' | 'range' | 'add-range') => {
    if (disabled) return;
    setState((current) => selectTabHeader(current, orderedIds, tabId, mode, activeTabId));
  }, [activeTabId, disabled, orderedIds]);
  const clear = useCallback(() => setState(EMPTY), []);
  const validSelectedTabIds = useMemo(
    () => new Set([...state.selectedTabIds].filter((id) => orderedIds.includes(id))),
    [state.selectedTabIds, orderedIds],
  );
  return {
    selectedTabIds: disabled ? EMPTY.selectedTabIds : validSelectedTabIds,
    anchorTabId: disabled ? null : state.anchorTabId,
    select,
    clear,
  };
}
