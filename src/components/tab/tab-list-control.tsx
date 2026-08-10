'use client';

import { memo, useCallback, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import { useAnchoredPopover } from '@/hooks/use-anchored-popover';
import { useCloseOnEscape } from '@/hooks/use-close-on-escape';
import { useMenuNavigation } from '@/hooks/use-menu-navigation';
import { useTabDisplayTitle } from '@/hooks/use-tab-display-title';
import { useTabStatusIndicator } from './use-tab-status-indicator';
import { ItemStatusIndicator } from '@/components/chat/work-item-primitives';
import {
  ANCHORED_VIEWPORT_MARGIN,
  resolveAnchoredAlignedLeft,
} from '@/lib/ui/anchored-viewport';
import { PHONE_TOUCH_TARGET, PHONE_TOUCH_TARGET_HEIGHT } from '@/lib/ui/touch-target';
import type { Tab } from '@/types/tab';

/** Widest the list is allowed to get; a phone gets whatever the viewport leaves. */
const TAB_LIST_MAX_WIDTH = 320;
/** Distance kept between the trigger and the list below it. */
const TAB_LIST_GAP = 4;

interface TabListPosition {
  top: number;
  left: number;
  width: number;
  maxHeight: number;
}

export interface TabListControlProps {
  tabs: Tab[];
  activeTabId: string;
  onActivate: (tabId: string) => void;
  onClose: (tabId: string) => void;
}

/**
 * The Phone viewport stand-in for the tab strip (#247).
 *
 * At 360px the chrome beside the strip leaves it about 140px once the scroll
 * gradients overlay, and one tab costs about 68px of fixture before its title —
 * so the strip can never show a second tab and scrubbing it is blind. This is
 * one control that names the active tab and opens the full list; the tab model,
 * creation, closing and reordering are all left where they are.
 */
export const TabListControl = memo(function TabListControl({
  tabs,
  activeTabId,
  onActivate,
  onClose: onCloseTab,
}: TabListControlProps) {
  const { t } = useI18n();
  const [isOpen, setIsOpen] = useState(false);

  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  const close = useCallback(() => setIsOpen(false), []);

  const calculatePosition = useCallback((trigger: HTMLElement): TabListPosition => {
    const rect = trigger.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const width = Math.min(
      TAB_LIST_MAX_WIDTH,
      Math.max(0, viewportWidth - ANCHORED_VIEWPORT_MARGIN * 2),
    );
    const top = rect.bottom + TAB_LIST_GAP;

    return {
      top,
      // Reuses the clamp #248 extracted rather than growing a second one: the
      // list is as wide as the phone allows, so an unclamped right-aligned
      // overlay would hang off whichever edge the trigger sits nearest.
      left: resolveAnchoredAlignedLeft({
        anchorRight: rect.right,
        elementWidth: width,
        viewportWidth,
      }),
      width,
      maxHeight: Math.max(0, window.innerHeight - top - ANCHORED_VIEWPORT_MARGIN),
    };
  }, []);

  const { position } = useAnchoredPopover<TabListPosition>({
    isOpen,
    onClose: close,
    triggerRef,
    containerRef,
    popoverRef,
    calculatePosition,
  });

  useCloseOnEscape(close, { enabled: isOpen });

  const handleMenuKeyDown = useMenuNavigation(popoverRef);

  const handleToggle = useCallback(() => setIsOpen((open) => !open), []);

  const handleSelect = useCallback(
    (tabId: string) => {
      setIsOpen(false);
      onActivate(tabId);
    },
    [onActivate],
  );

  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? tabs[0] ?? null;

  return (
    <div ref={containerRef} className="relative flex min-w-0 flex-1 items-stretch">
      <button
        ref={triggerRef}
        type="button"
        className={cn(
          'electron-no-drag flex min-w-0 flex-1 items-center gap-1.5 px-3',
          // Height only: the trigger already spans everything the bar's icons
          // leave it, and a minimum width would fight that (#270).
          PHONE_TOUCH_TARGET_HEIGHT,
          // The three icons beside it grew by 20px between them to reach the
          // floor, and they took that width off the tab name — 159px to 139px,
          // one under the 140px #247 fixed as the point where the name stops
          // being readable. The padding gives 8px of it straight back; the
          // target is 184x44 either way, so nothing here is hit area.
          'max-sm:px-2',
          'border-r border-r-(--divider) text-sm font-medium',
          'text-(--text-primary) transition-colors',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-(--accent)',
          isOpen && 'bg-(--sidebar-hover)',
        )}
        onClick={handleToggle}
        aria-haspopup="menu"
        aria-expanded={isOpen}
        aria-label={t('chat.tabList')}
        data-testid="tab-list-trigger"
      >
        {/* The ellipsis machinery the strip already uses — no second one. */}
        <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-left">
          {activeTab ? <TabListTriggerLabel tab={activeTab} /> : null}
        </span>
        <ChevronDown size={14} className="shrink-0 text-(--text-secondary)" />
      </button>

      {isOpen && position && typeof document !== 'undefined'
        ? createPortal(
            <div
              ref={popoverRef}
              role="menu"
              aria-label={t('chat.tabList')}
              className={cn(
                'fixed z-[9999] overflow-y-auto rounded-lg p-1.5',
                'bg-(--sidebar-bg) border border-(--divider)',
                'shadow-[0_8px_32px_rgba(0,0,0,0.24),0_2px_8px_rgba(0,0,0,0.16)]',
              )}
              style={{
                top: position.top,
                left: position.left,
                width: position.width,
                maxHeight: position.maxHeight,
              }}
              onKeyDown={handleMenuKeyDown}
              data-testid="tab-list-popover"
            >
              {tabs.map((tab) => (
                <TabListItem
                  key={tab.id}
                  tab={tab}
                  isActive={tab.id === activeTabId}
                  onSelect={handleSelect}
                  onClose={onCloseTab}
                />
              ))}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
});

/** The active tab's name on the trigger, derived exactly as the strip derives it. */
const TabListTriggerLabel = memo(function TabListTriggerLabel({ tab }: { tab: Tab }) {
  const title = useTabDisplayTitle(tab);
  return <>{title}</>;
});

interface TabListItemProps {
  tab: Tab;
  isActive: boolean;
  onSelect: (tabId: string) => void;
  onClose: (tabId: string) => void;
}

/**
 * One row. Every open tab gets one, so the list is the whole set rather than
 * the one-and-a-bit the strip could show.
 *
 * Switching and closing are two sibling buttons, not one button with a nested
 * one: a mis-tap here closes somebody's tab, so the close target gets its own
 * box, comfortably sized, with nothing overlapping it. Closing is the strip's
 * existing action given a surface a phone can reach — with the strip gone, the
 * remaining routes to it are a right-click, Ctrl+W and drag-and-drop, none of
 * which a phone has.
 */
const TabListItem = memo(function TabListItem({
  tab,
  isActive,
  onSelect,
  onClose,
}: TabListItemProps) {
  const { t } = useI18n();
  const title = useTabDisplayTitle(tab);
  const {
    statusKind,
    statusLabel,
    isProcessing,
    isAwaitingUser,
    hasUnread,
    isRunning,
    hasTerminalProcessingSession,
  } = useTabStatusIndicator(tab, isActive);

  return (
    <div className="flex items-center gap-1">
      <button
        type="button"
        role="menuitem"
        className={cn(
          'flex min-w-0 flex-1 items-center gap-2 rounded-md px-3 py-2.5 text-left text-[0.8125rem]',
          // The row already spans the list; only its height was ever short (#270).
          PHONE_TOUCH_TARGET_HEIGHT,
          'transition-colors focus:outline-none',
          isActive
            ? 'bg-(--sidebar-hover) text-(--text-primary)'
            : 'text-(--sidebar-text-active) hover:bg-(--sidebar-hover) focus:bg-(--sidebar-hover)',
        )}
        onClick={() => onSelect(tab.id)}
        title={title}
        data-testid="tab-list-item"
        data-tab-id={tab.id}
        data-active={String(isActive)}
      >
        {statusKind ? (
          <span
            className="flex shrink-0 items-center"
            data-testid="tab-list-item-status"
            data-status={statusKind}
            aria-label={statusLabel}
            title={statusLabel}
          >
            <ItemStatusIndicator
              isProcessing={isProcessing}
              isAwaitingUser={isAwaitingUser}
              hasUnread={hasUnread}
              isRunning={isRunning}
              sessionKind={hasTerminalProcessingSession ? 'terminal' : undefined}
              placement="inline"
              size="lg"
              surface="sidebar"
            />
          </span>
        ) : null}
        <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
          {title}
        </span>
        {isActive ? <Check size={14} className="shrink-0 text-(--accent)" /> : null}
      </button>

      <button
        type="button"
        className={cn(
          'flex h-10 w-10 shrink-0 items-center justify-center rounded-md',
          // `h-10 w-10` is 40px at the default font scale and 32.5px at 0.8125;
          // a mis-tap here closes somebody's tab, so it gets the px floor (#270).
          PHONE_TOUCH_TARGET,
          'text-(--text-muted) transition-colors',
          'hover:bg-(--sidebar-hover) hover:text-(--text-primary)',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--accent)',
        )}
        onClick={() => onClose(tab.id)}
        aria-label={t('chat.closeTab', { title })}
        data-testid="tab-list-item-close"
        data-tab-id={tab.id}
        tabIndex={-1}
      >
        <X size={14} />
      </button>
    </div>
  );
});
