'use client';

import { Check, ChevronRight, Tag } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Collection } from '@/types/collection';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';

interface CollectionMoveSubmenuProps {
  collections: Collection[];
  currentCollectionId: string | null;
  onMoveToCollection: (collectionId: string | null) => void;
  triggerClassName: string;
  itemClassName: string;
  label?: string;
  testIdPrefix?: string;
}

export function CollectionMoveSubmenu({
  collections,
  currentCollectionId,
  onMoveToCollection,
  triggerClassName,
  itemClassName,
  label = 'Move to',
  testIdPrefix = 'ctx',
}: CollectionMoveSubmenuProps) {
  const { t } = useI18n();
  const [isOpen, setIsOpen] = useState(false);
  const [openToLeft, setOpenToLeft] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const submenuRef = useRef<HTMLDivElement>(null);

  const openSubmenu = useCallback(() => setIsOpen(true), []);
  const closeSubmenu = useCallback(() => setIsOpen(false), []);

  useEffect(() => {
    if (!isOpen) return;

    const frame = requestAnimationFrame(() => {
      const triggerRect = triggerRef.current?.getBoundingClientRect();
      const submenuRect = submenuRef.current?.getBoundingClientRect();
      if (!triggerRect || !submenuRect) return;

      setOpenToLeft(triggerRect.right + submenuRect.width + 8 > window.innerWidth);
    });

    return () => cancelAnimationFrame(frame);
  }, [isOpen, collections.length]);

  return (
    <div
      className="relative"
      onMouseEnter={openSubmenu}
      onMouseLeave={closeSubmenu}
    >
      <button
        ref={triggerRef}
        role="menuitem"
        type="button"
        aria-haspopup="menu"
        aria-expanded={isOpen}
        className={triggerClassName}
        onFocus={openSubmenu}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setIsOpen((prev) => !prev);
        }}
        data-testid={`${testIdPrefix}-move-to`}
      >
        <Tag className="h-3.5 w-3.5 shrink-0 text-(--text-muted)" />
        <span className="flex-1 truncate">{label}</span>
        <ChevronRight className="h-3.5 w-3.5 shrink-0 text-(--text-muted)" />
      </button>

      {isOpen && (
        <div
          ref={submenuRef}
          role="menu"
          className={cn(
            'absolute top-0 z-10 min-w-[180px] rounded-lg border border-(--divider) bg-(--sidebar-bg) p-1.5',
            'shadow-[0_8px_32px_rgba(0,0,0,0.24),0_2px_8px_rgba(0,0,0,0.16)]',
            openToLeft ? 'right-full mr-1' : 'left-full ml-1',
          )}
          data-testid={`${testIdPrefix}-move-to-menu`}
        >
          {collections.map((collection) => (
            <button
              key={collection.id}
              type="button"
              role="menuitem"
              onClick={() => onMoveToCollection(collection.id)}
              className={cn(
                itemClassName,
                collection.id === currentCollectionId && 'text-(--accent)',
              )}
              data-testid={`${testIdPrefix}-move-collection-${collection.id}`}
            >
              <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: collection.color }} />
              <span className="flex-1 truncate">{collection.label}</span>
              {collection.id === currentCollectionId && <Check className="h-3 w-3 shrink-0 opacity-70" />}
            </button>
          ))}

          <button
            type="button"
            role="menuitem"
            onClick={() => onMoveToCollection(null)}
            className={cn(
              itemClassName,
              currentCollectionId === null && 'text-(--accent)',
            )}
            data-testid={`${testIdPrefix}-move-collection-uncategorized`}
          >
            <span className="h-2 w-2 shrink-0 rounded-full border border-(--text-muted) opacity-50" />
            <span className="flex-1">{t('task.creation.noCollection')}</span>
            {currentCollectionId === null && <Check className="h-3 w-3 shrink-0 opacity-70" />}
          </button>
        </div>
      )}
    </div>
  );
}
