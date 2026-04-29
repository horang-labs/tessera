/**
 * Keyboard Shortcuts Hook — registry-driven.
 *
 * Reads SHORTCUT_REGISTRY + user overrides from settings store, then registers the
 * 7 app-level MVP shortcuts. voice-input is handled separately in MessageInput.
 */

'use client';

const MIN_PANEL_WIDTH  = 250;
const MIN_PANEL_HEIGHT = 150;

import { useEffect, useCallback } from 'react';
import { useSettingsStore } from '@/stores/settings-store';
import { KeyboardManager } from '@/lib/keyboard/keyboard-manager';
import { SHORTCUT_IDS, type ShortcutId } from '@/lib/keyboard/registry';
import { getEffectiveShortcut } from '@/lib/keyboard/effective';
import { usePanelStore, selectActiveTab, EMPTY_PANELS } from '@/stores/panel-store';
import { useTabStore } from '@/stores/tab-store';
import { useBoardStore } from '@/stores/board-store';
import { toast } from '@/stores/notification-store';
import { i18n } from '@/lib/i18n';

export interface UseKeyboardShortcutsOptions {
  /** Reserved for future use (help toggle). Currently unused. */
  onToggleHelp?: () => void;
}

function getActivePanelSize(activePanelId: string): { width: number; height: number } | null {
  const el = document.querySelector(
    `[data-panel-wrapper="true"][data-panel-id="${activePanelId}"]`
  );
  if (!el) return null;
  const rect = el.getBoundingClientRect();
  return { width: rect.width, height: rect.height };
}

export function useKeyboardShortcuts(_options: UseKeyboardShortcutsOptions = {}) {
  const settingsStore = useSettingsStore();
  const overrides = useSettingsStore((s) => s.settings.shortcutOverrides);

  const panels = usePanelStore((state) => selectActiveTab(state)?.panels ?? EMPTY_PANELS);
  const activePanelId = usePanelStore((state) => selectActiveTab(state)?.activePanelId ?? '');
  const splitPanel = usePanelStore((state) => state.splitPanel);

  const tabs = useTabStore((state) => state.tabs);
  const activeTabId = useTabStore((state) => state.activeTabId);
  const setActiveTab = useTabStore((state) => state.setActiveTab);

  // Use the same code path as the UI "+" button (tab-bar.tsx) — creates an empty tab,
  // not a full session. Session is materialized lazily when the user sends a message.
  const handleNewTab = useCallback(() => {
    useTabStore.getState().createTab();
  }, []);

  // Same code path as the tab × button (tab-item.tsx) — closes the currently-active tab.
  const handleCloseTab = useCallback(() => {
    const { activeTabId: id, closeTab } = useTabStore.getState();
    if (!id) return;
    closeTab(id);
  }, []);

  const handleNextTab = useCallback(() => {
    if (tabs.length <= 1) return;
    const idx = tabs.findIndex((t) => t.id === activeTabId);
    setActiveTab(tabs[(idx + 1) % tabs.length].id);
  }, [tabs, activeTabId, setActiveTab]);

  const handlePrevTab = useCallback(() => {
    if (tabs.length <= 1) return;
    const idx = tabs.findIndex((t) => t.id === activeTabId);
    setActiveTab(tabs[(idx - 1 + tabs.length) % tabs.length].id);
  }, [tabs, activeTabId, setActiveTab]);

  const handleToggleSidebar = useCallback(() => {
    settingsStore.toggleSidebar();
  }, [settingsStore]);

  // Toggle between list and board view (board-store.setViewMode)
  const handleToggleView = useCallback(() => {
    const { viewMode, setViewMode } = useBoardStore.getState();
    setViewMode(viewMode === 'list' ? 'board' : 'list');
  }, []);

  const handleSplitRight = useCallback(() => {
    if (!panels[activePanelId]) return;
    const size = getActivePanelSize(activePanelId);
    if (size && size.width / 2 < MIN_PANEL_WIDTH) {
      toast.warning(i18n.t('panel.tooSmallToSplit'));
      return;
    }
    const newPanelId = splitPanel(activePanelId, 'horizontal', null);
    if (newPanelId) {
      const tabStore = useTabStore.getState();
      tabStore.pinTab(tabStore.activeTabId);
    }
  }, [panels, activePanelId, splitPanel]);

  const handleSplitDown = useCallback(() => {
    if (!panels[activePanelId]) return;
    const size = getActivePanelSize(activePanelId);
    if (size && size.height / 2 < MIN_PANEL_HEIGHT) {
      toast.warning(i18n.t('panel.tooSmallToSplit'));
      return;
    }
    const newPanelId = splitPanel(activePanelId, 'vertical', null);
    if (newPanelId) {
      const tabStore = useTabStore.getState();
      tabStore.pinTab(tabStore.activeTabId);
    }
  }, [panels, activePanelId, splitPanel]);

  const handlers: Partial<Record<ShortcutId, () => void | Promise<void>>> = {
    'new-tab':        handleNewTab,
    'close-tab':      handleCloseTab,
    'next-tab':       handleNextTab,
    'prev-tab':       handlePrevTab,
    'toggle-sidebar': handleToggleSidebar,
    'toggle-view':    handleToggleView,
    'split-right':    handleSplitRight,
    'split-down':     handleSplitDown,
    // 'voice-input' intentionally omitted — handled in MessageInput (per-session)
  };

  useEffect(() => {
    const manager = new KeyboardManager();
    for (const id of SHORTCUT_IDS) {
      const handler = handlers[id];
      if (!handler) continue;
      const key = getEffectiveShortcut(id, overrides);
      if (!key) continue;
      manager.register(key, () => { void handler(); }, { ignoreInputFields: false });
    }
    return () => manager.unregisterAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    overrides,
    handleNewTab, handleCloseTab, handleNextTab, handlePrevTab,
    handleToggleSidebar, handleToggleView, handleSplitRight, handleSplitDown,
  ]);
}
