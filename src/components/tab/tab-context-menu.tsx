'use client';

import { useEffect, useRef, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { X, XCircle, ArrowLeftToLine, ArrowRightToLine, Trash2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import { useCloseOnEscape } from '@/hooks/use-close-on-escape';
import { useMenuNavigation } from '@/hooks/use-menu-navigation';

export interface TabContextMenuProps {
  /** Position where the right-click occurred */
  position: { x: number; y: number };
  /** Whether there are tabs to the left of the target tab */
  hasTabsToLeft: boolean;
  /** Whether there are tabs to the right of the target tab */
  hasTabsToRight: boolean;
  /** Whether there are other tabs besides the target tab */
  hasOtherTabs: boolean;
  onClose: () => void;
  onCloseTab: () => void;
  onCloseOtherTabs: () => void;
  onCloseTabsToLeft: () => void;
  onCloseTabsToRight: () => void;
  onCloseAllTabs: () => void;
}

const MENU_WIDTH = 220;
const ITEM_HEIGHT = 32;
const PADDING = 6;

/**
 * TabContextMenu — portal-based right-click context menu for tab items.
 *
 * Follows the same pattern as TaskContextMenu:
 * - createPortal to document.body (avoids overflow clipping)
 * - Viewport-aware positioning with edge flipping
 * - ESC to close, click outside to close
 * - Keyboard navigation (ArrowUp/Down)
 */
export function TabContextMenu({
  position,
  hasTabsToLeft,
  hasTabsToRight,
  hasOtherTabs,
  onClose,
  onCloseTab,
  onCloseOtherTabs,
  onCloseTabsToLeft,
  onCloseTabsToRight,
  onCloseAllTabs,
}: TabContextMenuProps) {
  const { t } = useI18n();
  const menuRef = useRef<HTMLDivElement>(null);

  useCloseOnEscape(onClose, { capture: true });

  const menuPos = useMemo(() => {
    if (typeof window === 'undefined') {
      return null;
    }

    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const itemCount = 5; // close, close others, close left, close right, close all
    const menuHeight = ITEM_HEIGHT * itemCount + PADDING * 2 + 1; // +1 for divider

    let top = position.y;
    let left = position.x;

    // Flip up if near bottom
    if (top + menuHeight > vh - 8) {
      top = vh - menuHeight - 8;
    }
    if (top < 8) top = 8;

    // Clamp horizontal
    if (left + MENU_WIDTH > vw - 8) {
      left = vw - MENU_WIDTH - 8;
    }
    if (left < 8) left = 8;

    return { top, left };
  }, [position]);

  // Close on outside click
  useEffect(function handleOutsideClick() {
    function onMouseDown(e: MouseEvent) {
      if (!menuRef.current?.contains(e.target as Node)) {
        onClose();
      }
    }
    document.addEventListener('mousedown', onMouseDown, true);
    return () => document.removeEventListener('mousedown', onMouseDown, true);
  }, [onClose]);

  // Focus first item on mount
  useEffect(function focusFirstItem() {
    const firstItem = menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]');
    firstItem?.focus();
  }, []);

  const handleMenuKeyDown = useMenuNavigation(menuRef, '[role="menuitem"]:not(:disabled)');

  const handleCloseTab = useCallback(() => {
    onCloseTab();
    onClose();
  }, [onCloseTab, onClose]);

  const handleCloseOtherTabs = useCallback(() => {
    onCloseOtherTabs();
    onClose();
  }, [onCloseOtherTabs, onClose]);

  const handleCloseTabsToLeft = useCallback(() => {
    onCloseTabsToLeft();
    onClose();
  }, [onCloseTabsToLeft, onClose]);

  const handleCloseTabsToRight = useCallback(() => {
    onCloseTabsToRight();
    onClose();
  }, [onCloseTabsToRight, onClose]);

  const handleCloseAllTabs = useCallback(() => {
    onCloseAllTabs();
    onClose();
  }, [onCloseAllTabs, onClose]);

  const menuItemClass = cn(
    'w-full flex items-center gap-2 px-3 h-8 text-[0.75rem] text-left rounded-md',
    'text-(--sidebar-text-active) transition-colors',
    'hover:bg-(--sidebar-hover) focus:bg-(--sidebar-hover) focus:outline-none',
    'cursor-default',
  );

  const disabledItemClass = cn(
    'w-full flex items-center gap-2 px-3 h-8 text-[0.75rem] text-left rounded-md',
    'text-(--text-muted) cursor-default opacity-50',
  );

  const destructiveItemClass = cn(
    'w-full flex items-center gap-2 px-3 h-8 text-[0.75rem] text-left rounded-md',
    'text-(--error) transition-colors',
    'hover:bg-[color-mix(in_srgb,var(--error)_10%,transparent)]',
    'focus:bg-[color-mix(in_srgb,var(--error)_10%,transparent)] focus:outline-none',
    'cursor-default',
  );

  if (typeof document === 'undefined' || !menuPos) return null;

  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      aria-label="Tab options"
      className={cn(
        'fixed z-[9999] min-w-[200px] rounded-lg p-1.5',
        'bg-(--sidebar-bg) border border-(--divider)',
        'shadow-[0_8px_32px_rgba(0,0,0,0.24),0_2px_8px_rgba(0,0,0,0.16)]',
      )}
      style={{ top: menuPos.top, left: menuPos.left, width: MENU_WIDTH }}
      onKeyDown={handleMenuKeyDown}
      data-testid="tab-context-menu"
    >
      {/* Close Tab */}
      <button
        role="menuitem"
        className={menuItemClass}
        onClick={handleCloseTab}
        data-testid="ctx-close-tab"
      >
        <X className="w-3.5 h-3.5 shrink-0 text-(--text-muted)" />
        <span>{t('chat.closeTab' as Parameters<typeof t>[0], { title: '' }).replace(': ', '')}</span>
      </button>

      {/* Divider */}
      <div className="my-1 h-px bg-(--divider) opacity-40" />

      {/* Close Other Tabs */}
      <button
        role="menuitem"
        className={hasOtherTabs ? menuItemClass : disabledItemClass}
        onClick={hasOtherTabs ? handleCloseOtherTabs : undefined}
        disabled={!hasOtherTabs}
        data-testid="ctx-close-other-tabs"
      >
        <XCircle className="w-3.5 h-3.5 shrink-0 text-(--text-muted)" />
        <span>{t('chat.closeOtherTabs' as Parameters<typeof t>[0])}</span>
      </button>

      {/* Close Tabs to the Left */}
      <button
        role="menuitem"
        className={hasTabsToLeft ? menuItemClass : disabledItemClass}
        onClick={hasTabsToLeft ? handleCloseTabsToLeft : undefined}
        disabled={!hasTabsToLeft}
        data-testid="ctx-close-tabs-left"
      >
        <ArrowLeftToLine className="w-3.5 h-3.5 shrink-0 text-(--text-muted)" />
        <span>{t('chat.closeTabsToLeft' as Parameters<typeof t>[0])}</span>
      </button>

      {/* Close Tabs to the Right */}
      <button
        role="menuitem"
        className={hasTabsToRight ? menuItemClass : disabledItemClass}
        onClick={hasTabsToRight ? handleCloseTabsToRight : undefined}
        disabled={!hasTabsToRight}
        data-testid="ctx-close-tabs-right"
      >
        <ArrowRightToLine className="w-3.5 h-3.5 shrink-0 text-(--text-muted)" />
        <span>{t('chat.closeTabsToRight' as Parameters<typeof t>[0])}</span>
      </button>

      {/* Close All Tabs */}
      <button
        role="menuitem"
        className={destructiveItemClass}
        onClick={handleCloseAllTabs}
        data-testid="ctx-close-all-tabs"
      >
        <Trash2 className="w-3.5 h-3.5 shrink-0" />
        <span>{t('chat.closeAllTabs' as Parameters<typeof t>[0])}</span>
      </button>
    </div>,
    document.body,
  );
}
