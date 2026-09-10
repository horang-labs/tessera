'use client';

import { ReactElement, cloneElement, useState, useId, useRef, useEffect, type MouseEvent, type FocusEvent } from 'react';
import { createPortal } from 'react-dom';
import { useTooltipsEnabled } from '@/hooks/use-tooltips-enabled';
import { useEffectiveShortcut } from '@/hooks/use-effective-shortcut';
import { formatShortcut, detectPlatform, type Platform } from '@/lib/keyboard/format';
import { isBrowserConflict } from '@/lib/keyboard/conflicts';
import { useElectronPlatform } from '@/hooks/use-electron-platform';
import { useI18n } from '@/lib/i18n';
import type { ShortcutId } from '@/lib/keyboard/registry';

export interface ShortcutTooltipProps {
  id: ShortcutId;
  label: string;
  secondaryId?: ShortcutId;
  secondaryLabel?: string;
  /** Override platform detection. Used in tests. */
  platform?: Platform;
  hoverDelayMs?: number;
  children: ReactElement;
}

export function ShortcutTooltip({
  id,
  label,
  secondaryId,
  secondaryLabel,
  platform,
  hoverDelayMs = 0,
  children,
}: ShortcutTooltipProps) {
  const { t } = useI18n();
  const tooltipsEnabled = useTooltipsEnabled();
  const electronPlatform = useElectronPlatform();
  const isWebMode = !electronPlatform;
  const key = useEffectiveShortcut(id);
  const secondaryKey = useEffectiveShortcut(secondaryId ?? id);
  const plat = platform ?? detectPlatform();
  const tooltipId = useId();
  const [open, setOpen] = useState(false);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  function cancelHoverTimer() {
    if (hoverTimer.current !== null) clearTimeout(hoverTimer.current);
    hoverTimer.current = null;
  }
  useEffect(() => () => {
    if (hoverTimer.current !== null) clearTimeout(hoverTimer.current);
  }, [tooltipsEnabled, hoverDelayMs]);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);

  const formatted = key ? formatShortcut(key, plat) : '';
  const conflict = isWebMode && key !== null && isBrowserConflict(key);
  const secondaryConflict = secondaryId
    && isWebMode
    && secondaryKey !== null
    && isBrowserConflict(secondaryKey);
  const secondaryFormatted = secondaryId && secondaryKey
    ? formatShortcut(secondaryKey, plat)
    : '';

  type ChildProps = {
    onClick?: (e: MouseEvent<HTMLElement>) => void;
    onMouseEnter?: (e: MouseEvent<HTMLElement>) => void;
    onMouseLeave?: (e: MouseEvent<HTMLElement>) => void;
    onFocus?: (e: FocusEvent<HTMLElement>) => void;
    onBlur?: (e: FocusEvent<HTMLElement>) => void;
    [key: string]: unknown;
  };
  const childProps = children.props as ChildProps;

  function positionFromTrigger(el: HTMLElement) {
    const rect = el.getBoundingClientRect();
    setPosition({ top: rect.bottom + 8, left: rect.left + rect.width / 2 });
  }

  // cloneElement stores these handlers; it does not invoke them during render.
  // eslint-disable-next-line react-hooks/refs
  const trigger = cloneElement(children, {
    // Suppress native browser tooltip (from this element OR any ancestor's `title`)
    // so only our ShortcutTooltip shows. An empty `title` on the hovered element
    // stops the browser from walking up to a parent's title.
    title: '',
    'aria-keyshortcuts': [key, secondaryId ? secondaryKey : null].filter(Boolean).join(' ') || undefined,
    'aria-describedby': tooltipsEnabled && open ? tooltipId : undefined,
    onMouseEnter: (e: MouseEvent<HTMLElement>) => {
      cancelHoverTimer();
      if (tooltipsEnabled) {
        const target = e.currentTarget;
        if (hoverDelayMs > 0) {
          hoverTimer.current = setTimeout(() => {
            hoverTimer.current = null;
            positionFromTrigger(target);
            setOpen(true);
          }, hoverDelayMs);
        } else {
          positionFromTrigger(target);
          setOpen(true);
        }
      }
      childProps.onMouseEnter?.(e);
    },
    onMouseLeave: (e: MouseEvent<HTMLElement>) => {
      cancelHoverTimer();
      setOpen(false);
      childProps.onMouseLeave?.(e);
    },
    onClick: (e: MouseEvent<HTMLElement>) => {
      cancelHoverTimer();
      setOpen(false);
      childProps.onClick?.(e);
    },
    onFocus: (e: FocusEvent<HTMLElement>) => {
      // Touch/click focus can persist after activation; only keyboard focus
      // should open a tooltip without hover.
      if (tooltipsEnabled && e.currentTarget.matches(':focus-visible')) {
        positionFromTrigger(e.currentTarget);
        setOpen(true);
      }
      childProps.onFocus?.(e);
    },
    onBlur: (e: FocusEvent<HTMLElement>) => {
      cancelHoverTimer();
      setOpen(false);
      childProps.onBlur?.(e);
    },
  } as Record<string, unknown>);

  const tooltipNode = tooltipsEnabled && open && position ? (
    <div
      id={tooltipId}
      role="tooltip"
      className="fixed z-[2147483647] min-w-[190px] rounded-lg border border-white/10 bg-(--tooltip-bg) p-1.5 text-xs text-white shadow-xl pointer-events-none -translate-x-1/2"
      style={{ top: position.top, left: position.left }}
    >
      <div className="flex items-center justify-between gap-5 whitespace-nowrap px-1 py-0.5">
        <span>{label}</span>
        {formatted && <kbd className="font-mono text-[10px] text-white/65">{formatted}</kbd>}
        {conflict && <span className="text-(--warning)" title={t('shortcut.browserConflict')}>⚠</span>}
      </div>
      {secondaryId && secondaryLabel && (
        <div className="flex items-center justify-between gap-5 whitespace-nowrap px-1 py-0.5">
          <span>{secondaryLabel}</span>
          {secondaryFormatted && <kbd className="font-mono text-[10px] text-white/65">{secondaryFormatted}</kbd>}
          {secondaryConflict && <span className="text-(--warning)" title={t('shortcut.browserConflict')}>⚠</span>}
        </div>
      )}
    </div>
  ) : null;

  return (
    <>
      {trigger}
      {tooltipNode && typeof document !== 'undefined'
        ? createPortal(tooltipNode, document.body)
        : null}
    </>
  );
}
