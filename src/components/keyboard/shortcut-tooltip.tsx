'use client';

import { ReactElement, cloneElement, useState, useId, type MouseEvent, type FocusEvent } from 'react';
import { createPortal } from 'react-dom';
import { useEffectiveShortcut } from '@/hooks/use-effective-shortcut';
import { formatShortcut, detectPlatform, type Platform } from '@/lib/keyboard/format';
import { isBrowserConflict } from '@/lib/keyboard/conflicts';
import { useElectronPlatform } from '@/hooks/use-electron-platform';
import { useI18n } from '@/lib/i18n';
import type { ShortcutId } from '@/lib/keyboard/registry';

export interface ShortcutTooltipProps {
  id: ShortcutId;
  label: string;
  /** Override platform detection. Used in tests. */
  platform?: Platform;
  children: ReactElement;
}

export function ShortcutTooltip({ id, label, platform, children }: ShortcutTooltipProps) {
  const { t } = useI18n();
  const electronPlatform = useElectronPlatform();
  const isWebMode = !electronPlatform;
  const key = useEffectiveShortcut(id);
  const plat = platform ?? detectPlatform();
  const tooltipId = useId();
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);

  const formatted = key ? formatShortcut(key, plat) : '';
  const conflict = isWebMode && key !== null && isBrowserConflict(key);

  type ChildProps = {
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

  const trigger = cloneElement(children, {
    // Suppress native browser tooltip (from this element OR any ancestor's `title`)
    // so only our ShortcutTooltip shows. An empty `title` on the hovered element
    // stops the browser from walking up to a parent's title.
    title: '',
    'aria-keyshortcuts': key ?? undefined,
    'aria-describedby': open ? tooltipId : undefined,
    onMouseEnter: (e: MouseEvent<HTMLElement>) => {
      positionFromTrigger(e.currentTarget);
      setOpen(true);
      childProps.onMouseEnter?.(e);
    },
    onMouseLeave: (e: MouseEvent<HTMLElement>) => {
      setOpen(false);
      childProps.onMouseLeave?.(e);
    },
    onFocus: (e: FocusEvent<HTMLElement>) => {
      positionFromTrigger(e.currentTarget);
      setOpen(true);
      childProps.onFocus?.(e);
    },
    onBlur: (e: FocusEvent<HTMLElement>) => {
      setOpen(false);
      childProps.onBlur?.(e);
    },
  } as Record<string, unknown>);

  const tooltipNode = open && position ? (
    <div
      id={tooltipId}
      role="tooltip"
      className="fixed z-[2147483647] rounded-md bg-(--tooltip-bg) px-2.5 py-1 text-xs text-white shadow-md pointer-events-none -translate-x-1/2 whitespace-nowrap"
      style={{ top: position.top, left: position.left }}
    >
      {label}
      {formatted && <span className="ml-1.5 opacity-60">{formatted}</span>}
      {conflict && (
        <span className="ml-1.5 text-(--warning)" title={t('shortcut.browserConflict')}>
          ⚠
        </span>
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
