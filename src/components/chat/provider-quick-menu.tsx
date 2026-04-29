'use client';

import { useEffect, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Terminal } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useProvidersStore } from '@/stores/providers-store';
import { useCloseOnEscape } from '@/hooks/use-close-on-escape';
import { useMenuNavigation } from '@/hooks/use-menu-navigation';
import type { ProviderMeta } from '@/lib/cli/providers/types';

interface ProviderQuickMenuProps {
  anchorRect: DOMRect;
  /** Provider currently bound to the task — rendered with a subtle "current" hint. */
  currentProviderId?: string;
  onSelect: (providerId: string) => void;
  onClose: () => void;
}

const MENU_WIDTH = 200;
const ITEM_HEIGHT = 32;
const PADDING = 6;

export function ProviderQuickMenu({
  anchorRect,
  currentProviderId,
  onSelect,
  onClose,
}: ProviderQuickMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const providers = useProvidersStore((s) => s.providers);
  const fetchProviders = useProvidersStore((s) => s.fetch);
  const loading = useProvidersStore((s) => s.loading);

  useEffect(() => {
    if (providers === null && !loading) fetchProviders();
  }, [providers, loading, fetchProviders]);

  useCloseOnEscape(onClose, { capture: true });

  const selectable = useMemo<ProviderMeta[]>(
    () => (providers ?? []).filter((p) => p.status === 'connected'),
    [providers],
  );
  const showLoading = providers === null || (loading && selectable.length === 0);

  const menuPos = useMemo(() => {
    if (typeof window === 'undefined') return null;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const rowCount = Math.max(selectable.length, 1);
    const menuHeight = rowCount * ITEM_HEIGHT + PADDING * 2;

    let top = anchorRect.bottom + 4;
    let left = anchorRect.left;
    if (top + menuHeight > vh - 8) top = anchorRect.top - menuHeight - 4;
    if (left + MENU_WIDTH > vw - 8) left = vw - MENU_WIDTH - 8;
    if (left < 8) left = 8;
    return { top, left };
  }, [anchorRect, selectable.length]);

  useEffect(function handleOutsideClick() {
    function onMouseDown(e: MouseEvent) {
      const target = e.target as Node;
      if (!menuRef.current?.contains(target)) onClose();
    }
    document.addEventListener('mousedown', onMouseDown, true);
    return () => document.removeEventListener('mousedown', onMouseDown, true);
  }, [onClose]);

  useEffect(function focusFirstItem() {
    const firstItem = menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]');
    firstItem?.focus();
  }, []);

  const handleMenuKeyDown = useMenuNavigation(menuRef);

  if (typeof document === 'undefined' || !menuPos) return null;

  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      aria-label="Choose CLI provider for new session"
      className={cn(
        'fixed z-[9999] min-w-[200px] rounded-lg p-1.5',
        'bg-(--sidebar-bg) border border-(--divider)',
        'shadow-[0_8px_32px_rgba(0,0,0,0.24),0_2px_8px_rgba(0,0,0,0.16)]',
      )}
      style={{ top: menuPos.top, left: menuPos.left, width: MENU_WIDTH }}
      onKeyDown={handleMenuKeyDown}
      data-testid="provider-quick-menu"
    >
      {showLoading ? (
        <div className="px-3 py-2 text-[12px] text-(--text-muted)">Loading providers...</div>
      ) : selectable.length === 0 ? (
        <div className="px-3 py-2 text-[12px] text-(--text-muted)">No CLI available</div>
      ) : (
        selectable.map((provider) => {
          const isCurrent = provider.id === currentProviderId;
          return (
            <button
              key={provider.id}
              role="menuitem"
              type="button"
              onClick={() => {
                onSelect(provider.id);
                onClose();
              }}
              className={cn(
                'w-full flex items-center gap-2 px-3 h-8 text-[12px] text-left rounded-md',
                'text-(--sidebar-text-active) transition-colors',
                'hover:bg-(--sidebar-hover) focus:bg-(--sidebar-hover) focus:outline-none',
                'cursor-default',
              )}
              data-testid={`provider-quick-menu-item-${provider.id}`}
            >
              <Terminal className="h-3.5 w-3.5 text-(--text-muted)" />
              <span className="flex-1 truncate">{provider.displayName}</span>
              {isCurrent && (
                <span className="text-[10px] text-(--text-muted)">current</span>
              )}
            </button>
          );
        })
      )}
    </div>,
    document.body,
  );
}
