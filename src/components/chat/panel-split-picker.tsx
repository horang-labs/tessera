'use client';

import { useCallback, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { usePanelStore, selectActiveTab, EMPTY_PANELS } from '@/stores/panel-store';
import { useTabStore } from '@/stores/tab-store';
import { toast } from '@/stores/notification-store';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { useAnchoredPopover } from '@/hooks/use-anchored-popover';
import { ShortcutTooltip } from '@/components/keyboard/shortcut-tooltip';
import type { ShortcutId } from '@/lib/keyboard/registry';

const MIN_PANEL_WIDTH = 250;
const MIN_PANEL_HEIGHT = 150;

interface FixedPopoverPosition {
  right: number;
  bottom: number;
  maxHeight: number;
}

function calculatePopoverPosition(trigger: HTMLElement): FixedPopoverPosition {
  const rect = trigger.getBoundingClientRect();
  return {
    right: Math.max(12, window.innerWidth - rect.right),
    bottom: Math.max(12, window.innerHeight - rect.top + 8),
    maxHeight: Math.max(180, rect.top - 16),
  };
}

function getPanelRect(panelId: string): DOMRect | null {
  const panelElement = document.querySelector(`[data-panel-wrapper="true"][data-panel-id="${panelId}"]`);
  return panelElement instanceof HTMLElement ? panelElement.getBoundingClientRect() : null;
}

interface PanelSplitPickerProps {
  sessionId: string;
  compact?: boolean;
}

const SPLIT_CARD_CONFIG = [
  {
    direction: 'horizontal' as const,
    testId: 'panel-split-right',
    labelKey: 'panel.splitRight' as const,
    shortcutLabelKey: 'shortcut.splitRight' as const,
    shortcutId: 'split-right' as ShortcutId,
    hintKey: 'panel.splitRightHint' as const,
  },
  {
    direction: 'vertical' as const,
    testId: 'panel-split-down',
    labelKey: 'panel.splitDown' as const,
    shortcutLabelKey: 'shortcut.splitDown' as const,
    shortcutId: 'split-down' as ShortcutId,
    hintKey: 'panel.splitDownHint' as const,
  },
];

function PreviewPanel({ active = false }: { active?: boolean }) {
  return (
    <div
      className={cn(
        'relative overflow-hidden rounded-[4px] border p-1.5',
        active
          ? 'border-(--accent)/30 bg-(--accent)/8'
          : 'border-(--divider)/80 bg-(--chat-header-bg)',
      )}
    >
      {active && (
        <span
          aria-hidden="true"
          className="absolute right-1 top-1 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-(--accent) text-[10px] font-semibold leading-none text-white shadow-sm"
        >
          +
        </span>
      )}
      <div className="mb-2 h-1 w-full rounded-full bg-(--text-muted)/18" />
      <div className="space-y-1">
        <span className={cn('block h-1 rounded-full', active ? 'w-3/4 bg-(--accent)/28' : 'w-4/5 bg-(--text-muted)/18')} />
        <span className={cn('block h-1 rounded-full', active ? 'w-1/2 bg-(--accent)/24' : 'w-3/5 bg-(--text-muted)/16')} />
      </div>
    </div>
  );
}

function SplitPreview({ direction }: { direction: 'horizontal' | 'vertical' }) {
  return (
    <div
      className={cn(
        'grid h-[68px] overflow-hidden rounded-md border border-(--divider) bg-(--chat-bg) p-1',
        direction === 'horizontal'
          ? 'grid-cols-[1fr_0.78fr] gap-1'
          : 'grid-rows-2 gap-1',
      )}
      aria-hidden="true"
    >
      <PreviewPanel />
      <PreviewPanel active />
    </div>
  );
}

export function PanelSplitPicker({ sessionId, compact = false }: PanelSplitPickerProps) {
  const { t } = useI18n();
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const close = useCallback(() => setIsOpen(false), []);
  const { position, updatePosition } = useAnchoredPopover({
    isOpen,
    onClose: close,
    triggerRef,
    containerRef,
    popoverRef: menuRef,
    calculatePosition: calculatePopoverPosition,
  });

  const panels = usePanelStore((state) => selectActiveTab(state)?.panels ?? EMPTY_PANELS);
  const splitPanel = usePanelStore((state) => state.splitPanel);
  const setActivePanelId = usePanelStore((state) => state.setActivePanelId);
  const currentPanelId = useMemo(
    () => Object.entries(panels).find(([, panel]) => panel.sessionId === sessionId)?.[0] ?? null,
    [panels, sessionId],
  );
  const disableSplit = !currentPanelId;

  const handleSplit = useCallback((direction: 'horizontal' | 'vertical') => {
    if (!currentPanelId) {
      return;
    }

    const rect = getPanelRect(currentPanelId);
    if (rect) {
      if (direction === 'horizontal' && rect.width / 2 < MIN_PANEL_WIDTH) {
        toast.warning(t('panel.tooSmallToSplit'));
        return;
      }

      if (direction === 'vertical' && rect.height / 2 < MIN_PANEL_HEIGHT) {
        toast.warning(t('panel.tooSmallToSplit'));
        return;
      }
    }

    setActivePanelId(currentPanelId);
    const newPanelId = splitPanel(currentPanelId, direction, null);
    if (newPanelId) {
      const tabStore = useTabStore.getState();
      tabStore.pinTab(tabStore.activeTabId);
    }
    setIsOpen(false);
  }, [currentPanelId, setActivePanelId, splitPanel, t]);

  return (
    <div ref={containerRef} className="relative shrink-0">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => {
          if (!isOpen) {
            updatePosition();
          }
          setIsOpen((value) => !value);
        }}
        className={cn(
          'inline-flex items-center gap-2 rounded-md border text-[11px] transition-colors',
          compact ? 'h-7 px-2' : 'h-8 px-2.5',
          'border-(--divider) bg-(--chat-header-bg) text-(--text-secondary)',
          'hover:border-(--accent)/35 hover:bg-(--sidebar-hover) hover:text-(--text-primary)',
          isOpen && 'border-(--accent)/35 bg-(--sidebar-hover) text-(--text-primary)',
        )}
        data-testid="panel-split-trigger"
        aria-expanded={isOpen}
        aria-haspopup="dialog"
        title={t('panel.createPanel')}
      >
        <span className="relative h-4 w-4 rounded-[4px] border border-(--accent)/25 bg-(--accent)/10">
          <span className="absolute inset-y-[3px] left-1/2 w-px -translate-x-1/2 bg-(--accent)" />
          <span className="absolute inset-x-[3px] top-1/2 h-px -translate-y-1/2 bg-(--accent)" />
        </span>
        <span>{compact ? t('panel.createPanelShort') : t('panel.createPanel')}</span>
      </button>

      {isOpen && position && typeof document !== 'undefined' && createPortal(
        <div
          ref={menuRef}
          data-testid="panel-split-menu"
          data-side="top"
          className="fixed z-[10001] w-[296px] rounded-lg border border-(--chat-header-border) bg-(--chat-header-bg) p-2 shadow-lg"
          style={{
            right: position.right,
            bottom: position.bottom,
            maxHeight: Math.min(position.maxHeight, 320),
          }}
        >
          <div className="mb-2 px-1">
            <strong className="text-[12px] text-(--text-primary)">{t('panel.splitCurrentPanel')}</strong>
          </div>

          <div className="grid grid-cols-2 gap-2">
            {SPLIT_CARD_CONFIG.map((item) => (
              <ShortcutTooltip key={item.direction} id={item.shortcutId} label={t(item.shortcutLabelKey)}>
              <button
                type="button"
                onClick={() => handleSplit(item.direction)}
                disabled={disableSplit}
                className={cn(
                  'rounded-lg border bg-(--input-bg) p-2 text-left transition-colors',
                  'border-(--divider) hover:border-(--accent)/40 hover:bg-(--chat-bg)',
                  disableSplit && 'cursor-not-allowed opacity-50',
                )}
                data-testid={item.testId}
                aria-label={t(item.labelKey)}
              >
                <SplitPreview direction={item.direction} />
                <div className="mt-2">
                  <div className="text-[12px] font-medium text-(--text-primary)">{t(item.labelKey)}</div>
                  <div className="mt-0.5 text-[10px] leading-4 text-(--text-muted)">{t(item.hintKey)}</div>
                </div>
              </button>
              </ShortcutTooltip>
            ))}
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}
