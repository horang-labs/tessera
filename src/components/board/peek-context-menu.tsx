'use client';

import { useEffect, useRef } from 'react';
import { X } from 'lucide-react';
import { useCloseOnEscape } from '@/hooks/use-close-on-escape';
import { useMenuNavigation } from '@/hooks/use-menu-navigation';
import { useI18n } from '@/lib/i18n';

interface PeekContextMenuProps {
  position: { x: number; y: number };
  onDismiss: () => void;
  onClosePeek: () => void;
  onToggleView?: () => void;
  toggleViewLabel: string;
}

export function PeekContextMenu({
  position, onDismiss, onClosePeek, onToggleView, toggleViewLabel,
}: PeekContextMenuProps) {
  const { t } = useI18n();
  const menuRef = useRef<HTMLDivElement>(null);
  const handleKeyDown = useMenuNavigation(menuRef);
  useCloseOnEscape(onDismiss, { capture: true });

  useEffect(() => {
    const menu = menuRef.current;
    const previousFocus = document.activeElement;
    menu?.querySelector<HTMLButtonElement>('button')?.focus();
    const dismissOutside = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) onDismiss();
    };
    document.addEventListener('pointerdown', dismissOutside, true);
    window.addEventListener('resize', onDismiss);
    return () => {
      document.removeEventListener('pointerdown', dismissOutside, true);
      window.removeEventListener('resize', onDismiss);
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected
        && (document.activeElement === document.body || menu?.contains(document.activeElement))) {
        previousFocus.focus({ preventScroll: true });
      }
    };
  }, [onDismiss]);

  const itemClass = 'flex h-8 w-full items-center gap-2 rounded-md px-3 text-left text-xs text-(--sidebar-text-active) hover:bg-(--sidebar-hover) focus:bg-(--sidebar-hover) focus:outline-none';
  const height = onToggleView ? 85 : 44;

  return (
    <div
      ref={menuRef}
      role="menu"
      aria-label={t('common.closePeek')}
      data-testid="kanban-peek-context-menu"
      className="fixed z-[100] w-[220px] rounded-lg border border-(--divider) bg-(--sidebar-bg) p-1.5 shadow-xl"
      style={{
        left: Math.max(8, Math.min(position.x, window.innerWidth - 228)),
        top: Math.max(8, Math.min(position.y, window.innerHeight - height - 8)),
      }}
      onPointerDown={(event) => event.stopPropagation()}
      onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); }}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === 'Tab') {
          event.preventDefault();
          onDismiss();
        } else handleKeyDown(event);
      }}
    >
      <button type="button" role="menuitem" className={itemClass} onClick={() => {
        onDismiss();
        onClosePeek();
      }}>
        <X className="h-4 w-4" aria-hidden="true" />
        {t('common.closePeek')}
      </button>
      {onToggleView ? (
        <>
          <div role="separator" className="my-1 border-t border-(--divider)" />
          <button type="button" role="menuitem" className={itemClass} onClick={() => {
            onDismiss();
            onToggleView();
          }}>
            {toggleViewLabel}
          </button>
        </>
      ) : null}
    </div>
  );
}
