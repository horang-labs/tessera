import type { Tab } from '@/types/tab';

export type TabNavigationDirection = 'previous' | 'next';

export function getAdjacentTabId(
  tabs: readonly Tab[],
  activeTabId: string,
  direction: TabNavigationDirection,
): string | null {
  if (tabs.length < 2) return null;

  const activeIndex = tabs.findIndex((tab) => tab.id === activeTabId);
  if (activeIndex === -1) return null;

  const offset = direction === 'previous' ? -1 : 1;
  return tabs[(activeIndex + offset + tabs.length) % tabs.length].id;
}
