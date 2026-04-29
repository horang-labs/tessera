'use client';

import { useCallback, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from 'react';

export function useMenuNavigation(
  menuRef: RefObject<HTMLElement | null>,
  itemSelector = '[role="menuitem"]',
) {
  return useCallback((event: ReactKeyboardEvent<HTMLElement>) => {
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLElement>(itemSelector) ?? []);
    if (items.length === 0) return;

    const activeIndex = items.indexOf(document.activeElement as HTMLElement);

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      items[(activeIndex + 1 + items.length) % items.length]?.focus();
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      items[(activeIndex - 1 + items.length) % items.length]?.focus();
    }
  }, [itemSelector, menuRef]);
}
