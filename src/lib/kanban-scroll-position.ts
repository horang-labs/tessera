const KANBAN_SCROLL_KEY_NONE = '__none__';
const KANBAN_SCROLL_KEY_ALL = '__all__';
const KANBAN_SCROLL_AREA_SELECTOR = '[data-kanban-scroll-area="true"]';
const KANBAN_SCROLL_STORAGE_PREFIX = 'kanban-scroll:';

const kanbanScrollPositions = new Map<string, number>();

export function getKanbanScrollPositionKey(
  projectDir: string | null,
  collectionFilter: string | null,
): string {
  return `${projectDir ?? KANBAN_SCROLL_KEY_NONE}:${collectionFilter ?? KANBAN_SCROLL_KEY_ALL}`;
}

export function getKanbanScrollPosition(key: string): number {
  if (typeof window !== 'undefined') {
    try {
      const storedPosition = window.sessionStorage.getItem(`${KANBAN_SCROLL_STORAGE_PREFIX}${key}`);
      if (storedPosition !== null) {
        const parsedPosition = Number(storedPosition);
        if (Number.isFinite(parsedPosition)) {
          kanbanScrollPositions.set(key, parsedPosition);
          return parsedPosition;
        }
      }
    } catch {
      // Fall back to the in-memory cache when session storage is unavailable.
    }
  }

  return kanbanScrollPositions.get(key) ?? 0;
}

export function saveKanbanScrollPosition(key: string, scrollLeft: number): void {
  kanbanScrollPositions.set(key, scrollLeft);
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.setItem(`${KANBAN_SCROLL_STORAGE_PREFIX}${key}`, String(scrollLeft));
  } catch {
    // Session storage can be unavailable in restricted browser contexts.
  }
}

export function saveCurrentKanbanScrollPosition(
  projectDir: string | null,
  collectionFilter: string | null,
): void {
  if (typeof document === 'undefined') return;
  const scrollArea = document.querySelector<HTMLDivElement>(KANBAN_SCROLL_AREA_SELECTOR);
  if (!scrollArea) return;
  saveKanbanScrollPosition(
    getKanbanScrollPositionKey(projectDir, collectionFilter),
    scrollArea.scrollLeft,
  );
}
