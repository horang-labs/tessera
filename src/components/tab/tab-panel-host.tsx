'use client';

import { memo } from 'react';
import { useTabStore } from '@/stores/tab-store';
import { usePanelStore, TabIdContext } from '@/stores/panel-store';
import PanelContainer from '@/components/panel/panel-container';

/**
 * Manages the LRU-bounded set of mounted PanelContainer instances.
 *
 * - Each tab in lruTabIds gets a slot div.
 * - Active slot: visible.
 * - Inactive slots: visibility:hidden (not unmounted — preserves WebSocket/scroll/layout state).
 * - Tabs outside lruTabIds: no slot rendered at all (BR-UI-017).
 *
 * v3: Each slot reads its own layout from panelStore.tabPanels[tabId]?.layout
 * and wraps itself in TabIdContext.Provider so nested components can identify
 * which tab they belong to.
 */

const TabSlot = memo(function TabSlot({ tabId, isActive }: { tabId: string; isActive: boolean }) {
  const layout = usePanelStore((s) => s.tabPanels[tabId]?.layout);
  if (!layout) return null;

  return (
    <TabIdContext.Provider value={tabId}>
      <div
        role="tabpanel"
        id={`${tabId}-panel`}
        aria-labelledby={tabId}
        aria-hidden={!isActive}
        style={{
          position: 'absolute',
          inset: 0,
          display: 'flex',
          visibility: isActive ? 'visible' : 'hidden',
          flexDirection: 'column',
        }}
        data-testid="tab-panel-slot"
        data-tab-id={tabId}
        data-active={String(isActive)}
      >
        <PanelContainer node={layout} />
      </div>
    </TabIdContext.Provider>
  );
});

export const TabPanelHost = memo(function TabPanelHost() {
  const lruTabIds = useTabStore((state) => state.lruTabIds);
  const activeTabId = useTabStore((state) => state.activeTabId);

  return (
    <div
      style={{ position: 'relative', flex: 1, overflow: 'hidden' }}
      data-testid="tab-panel-host"
    >
      {lruTabIds.map((tabId) => (
        <TabSlot key={tabId} tabId={tabId} isActive={tabId === activeTabId} />
      ))}
    </div>
  );
});
