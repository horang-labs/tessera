interface TabIdentity {
  id: string;
}

export function orderMountedTabIds(
  tabs: readonly TabIdentity[],
  lruTabIds: readonly string[],
): string[] {
  const mountedIds = new Set(lruTabIds);
  return tabs.map((tab) => tab.id).filter((tabId) => mountedIds.has(tabId));
}
