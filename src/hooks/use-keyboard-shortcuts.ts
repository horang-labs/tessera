/**
 * Keyboard Shortcuts Hook — registry-driven.
 *
 * Reads SHORTCUT_REGISTRY + user overrides from settings store, then registers the
 * App-level shortcuts. voice-input is handled separately in MessageInput.
 */

'use client';

const MIN_PANEL_WIDTH  = 250;
const MIN_PANEL_HEIGHT = 150;
const PANEL_DIRECTION_EPSILON = 1;

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
import { v4 as uuidv4 } from 'uuid';

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

type PanelFocusDirection = 'left' | 'right' | 'up' | 'down';

interface PanelRect {
  panelId: string;
  rect: DOMRect;
}

function getRenderedPanelRects(): PanelRect[] {
  return Array.from(document.querySelectorAll<HTMLElement>(
    '[data-panel-wrapper="true"][data-panel-id]'
  ))
    .map((el) => {
      const panelId = el.dataset.panelId;
      return panelId ? { panelId, rect: el.getBoundingClientRect() } : null;
    })
    .filter((panel): panel is PanelRect => panel !== null);
}

function getPanelCenter(rect: DOMRect): { x: number; y: number } {
  return {
    x: rect.left + rect.width / 2,
    y: rect.top + rect.height / 2,
  };
}

function getDirectionalPanelId(activePanelId: string, direction: PanelFocusDirection): string | null {
  const panels = getRenderedPanelRects();
  const active = panels.find((panel) => panel.panelId === activePanelId);
  if (!active || panels.length <= 1) return null;

  const activeCenter = getPanelCenter(active.rect);
  let best: { panelId: string; score: number } | null = null;

  for (const candidate of panels) {
    if (candidate.panelId === activePanelId) continue;

    const rect = candidate.rect;
    const center = getPanelCenter(rect);
    let primaryDistance: number;
    let crossAxisDistance: number;

    switch (direction) {
      case 'left':
        if (rect.right > active.rect.left + PANEL_DIRECTION_EPSILON) continue;
        primaryDistance = active.rect.left - rect.right;
        crossAxisDistance = Math.abs(activeCenter.y - center.y);
        break;
      case 'right':
        if (rect.left < active.rect.right - PANEL_DIRECTION_EPSILON) continue;
        primaryDistance = rect.left - active.rect.right;
        crossAxisDistance = Math.abs(activeCenter.y - center.y);
        break;
      case 'up':
        if (rect.bottom > active.rect.top + PANEL_DIRECTION_EPSILON) continue;
        primaryDistance = active.rect.top - rect.bottom;
        crossAxisDistance = Math.abs(activeCenter.x - center.x);
        break;
      case 'down':
        if (rect.top < active.rect.bottom - PANEL_DIRECTION_EPSILON) continue;
        primaryDistance = rect.top - active.rect.bottom;
        crossAxisDistance = Math.abs(activeCenter.x - center.x);
        break;
    }

    const score = primaryDistance * 1000 + crossAxisDistance;
    if (!best || score < best.score) {
      best = { panelId: candidate.panelId, score };
    }
  }

  return best?.panelId ?? null;
}

export function useKeyboardShortcuts(_options: UseKeyboardShortcutsOptions = {}) {
  const settingsStore = useSettingsStore();
  const overrides = useSettingsStore((s) => s.settings.shortcutOverrides);

  const panels = usePanelStore((state) => selectActiveTab(state)?.panels ?? EMPTY_PANELS);
  const activePanelId = usePanelStore((state) => selectActiveTab(state)?.activePanelId ?? '');
  const splitPanel = usePanelStore((state) => state.splitPanel);
  const createTerminalPanel = usePanelStore((state) => state.createTerminalPanel);
  const setActivePanelId = usePanelStore((state) => state.setActivePanelId);

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

  const handleToggleTerminal = useCallback(() => {
    if (!panels[activePanelId]) return;
    const size = getActivePanelSize(activePanelId);
    if (size && size.height / 2 < MIN_PANEL_HEIGHT) {
      toast.warning(i18n.t('panel.tooSmallToSplit'));
      return;
    }

    const terminalPanelId = createTerminalPanel(activePanelId, uuidv4(), 'vertical');
    if (terminalPanelId) {
      const tabStore = useTabStore.getState();
      tabStore.pinTab(tabStore.activeTabId);
    }
  }, [panels, activePanelId, createTerminalPanel]);

  const handleFocusPanel = useCallback((direction: PanelFocusDirection) => {
    if (!panels[activePanelId]) return;
    const nextPanelId = getDirectionalPanelId(activePanelId, direction);
    if (!nextPanelId || !panels[nextPanelId]) return;
    setActivePanelId(nextPanelId);
  }, [panels, activePanelId, setActivePanelId]);

  const handlers: Partial<Record<ShortcutId, () => void | Promise<void>>> = {
    'new-tab':        handleNewTab,
    'close-tab':      handleCloseTab,
    'toggle-sidebar': handleToggleSidebar,
    'toggle-view':    handleToggleView,
    'split-right':    handleSplitRight,
    'split-down':     handleSplitDown,
    'toggle-terminal': handleToggleTerminal,
    'focus-panel-left':  () => handleFocusPanel('left'),
    'focus-panel-right': () => handleFocusPanel('right'),
    'focus-panel-up':    () => handleFocusPanel('up'),
    'focus-panel-down':  () => handleFocusPanel('down'),
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
    handleNewTab, handleCloseTab,
    handleToggleSidebar, handleToggleView, handleSplitRight, handleSplitDown,
    handleToggleTerminal, handleFocusPanel,
  ]);
}
