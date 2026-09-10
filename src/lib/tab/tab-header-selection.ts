export type TabHeaderSelection = {
  selectedTabIds: Set<string>;
  anchorTabId: string | null;
};

export function selectTabHeader(
  state: TabHeaderSelection,
  orderedTabIds: readonly string[],
  tabId: string,
  mode: 'toggle' | 'range' | 'add-range',
  fallbackAnchorId: string | null,
): TabHeaderSelection {
  const ids = new Set(orderedTabIds);
  if (!ids.has(tabId)) return state;
  const anchor: string = state.anchorTabId && ids.has(state.anchorTabId)
    ? state.anchorTabId
    : fallbackAnchorId && ids.has(fallbackAnchorId)
      ? fallbackAnchorId
      : tabId;
  if (mode === 'toggle') {
    const selectedTabIds = new Set(state.selectedTabIds);
    // Starting a multi-selection extends the currently open tab.
    if (selectedTabIds.size === 0 && fallbackAnchorId && ids.has(fallbackAnchorId) && fallbackAnchorId !== tabId) {
      selectedTabIds.add(fallbackAnchorId);
    }
    selectedTabIds.has(tabId) ? selectedTabIds.delete(tabId) : selectedTabIds.add(tabId);
    return { selectedTabIds, anchorTabId: tabId };
  }
  const from = Math.max(0, orderedTabIds.indexOf(anchor));
  const to = orderedTabIds.indexOf(tabId);
  const range = orderedTabIds.slice(Math.min(from, to), Math.max(from, to) + 1);
  return {
    selectedTabIds: mode === 'add-range' ? new Set([...state.selectedTabIds, ...range]) : new Set(range),
    anchorTabId: anchor,
  };
}

export function pruneTabHeaderSelection(
  state: TabHeaderSelection,
  orderedTabIds: readonly string[],
): TabHeaderSelection {
  const ids = new Set(orderedTabIds);
  return {
    selectedTabIds: new Set([...state.selectedTabIds].filter((id) => ids.has(id))),
    anchorTabId: state.anchorTabId && ids.has(state.anchorTabId) ? state.anchorTabId : null,
  };
}
