'use client';

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTabStore } from '@/stores/tab-store';
import { useSessionStore } from '@/stores/session-store';
import { usePanelStore, selectActiveTab, EMPTY_PANELS } from '@/stores/panel-store';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import { isSpecialSession, getSpecialSessionTitle, getSpecialSessionTitleKey } from '@/lib/constants/special-sessions';
import { ShortcutTooltip } from '@/components/keyboard/shortcut-tooltip';
import { useI18n } from '@/lib/i18n';

/** Animation duration in ms */
const SLIDE_DURATION = 300;

/** Minimum margin (px) required to show a content-mode overlay pill */
const MIN_MARGIN_PX = 50;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AdjacentTab {
  tabId: string;
  sessionId: string | null;
  title: string;
}

// ---------------------------------------------------------------------------
// Hook: useAdjacentTabs
// ---------------------------------------------------------------------------

function useAdjacentTabs(): { left: AdjacentTab | null; right: AdjacentTab | null; activeIndex: number; totalTabs: number } {
  const { t } = useI18n();
  const tabs = useTabStore((s) => s.tabs);
  const activeTabId = useTabStore((s) => s.activeTabId);
  const tabPanels = usePanelStore((s) => s.tabPanels);

  return useMemo(() => {
    const activeIdx = tabs.findIndex((t) => t.id === activeTabId);
    if (activeIdx === -1) return { left: null, right: null, activeIndex: 0, totalTabs: tabs.length };

    const resolveTab = (tab: typeof tabs[number]): AdjacentTab => {
      const tabData = tabPanels[tab.id];
      const sessionId = tabData
        ? (tabData.panels[tabData.activePanelId]?.sessionId ?? null)
        : null;
      let title = t('chat.newTabDefault');
      if (sessionId && isSpecialSession(sessionId)) {
        const titleKey = getSpecialSessionTitleKey(sessionId);
        title = titleKey ? t(titleKey) : getSpecialSessionTitle(sessionId) ?? t('chat.newTabDefault');
      } else if (tab.title) {
        title = tab.title;
      }
      return { tabId: tab.id, sessionId, title };
    };

    const left = activeIdx > 0 ? resolveTab(tabs[activeIdx - 1]) : null;
    const right = activeIdx < tabs.length - 1 ? resolveTab(tabs[activeIdx + 1]) : null;

    return { left, right, activeIndex: activeIdx, totalTabs: tabs.length };
  }, [tabs, activeTabId, tabPanels, t]);
}

// ---------------------------------------------------------------------------
// Hook: useContentEdges — measures the 960px content area boundaries
// ---------------------------------------------------------------------------

function useContentEdges(enabled: boolean) {
  const contentRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState<{
    top: number; height: number; left: number; right: number;
    marginLeft: number; marginRight: number;
  } | null>(null);

  useEffect(() => {
    if (!enabled) {
      return;
    }

    const measure = () => {
      const content = contentRef.current;
      const container = containerRef.current;
      if (!content || !container) return;
      const cr = content.getBoundingClientRect();
      const pr = container.getBoundingClientRect();
      setEdges({
        top: cr.top, height: cr.height,
        left: cr.left, right: cr.right,
        marginLeft: cr.left - pr.left,
        marginRight: pr.right - cr.right,
      });
    };

    measure();

    const ro = new ResizeObserver(measure);
    if (contentRef.current) ro.observe(contentRef.current);
    if (containerRef.current) ro.observe(containerRef.current);
    window.addEventListener('resize', measure);

    return () => { ro.disconnect(); window.removeEventListener('resize', measure); };
  }, [enabled]);

  return {
    contentRef,
    containerRef,
    edges: enabled ? edges : null,
  };
}

// ---------------------------------------------------------------------------
// Sub-component: SideNavTitle (reads session title reactively)
// ---------------------------------------------------------------------------

const SideNavTitle = memo(function SideNavTitle({
  sessionId,
  fallbackTitle,
}: {
  sessionId: string | null;
  fallbackTitle: string;
}) {
  const { t } = useI18n();
  const titleKey = sessionId ? getSpecialSessionTitleKey(sessionId) : null;
  const specialTitle = sessionId ? getSpecialSessionTitle(sessionId) : null;
  const session = useSessionStore(
    useCallback(
      (state) => (sessionId && !isSpecialSession(sessionId) ? state.getSession(sessionId) : undefined),
      [sessionId],
    ),
  );
  if (titleKey) return <>{t(titleKey)}</>;
  if (specialTitle) return <>{specialTitle}</>;
  return <>{session?.title ?? fallbackTitle}</>;
});

// ---------------------------------------------------------------------------
// Sub-component: ContentPill — portal-rendered pill for single-panel mode
// ---------------------------------------------------------------------------

const ContentPill = memo(function ContentPill({
  adjacent,
  side,
  onNavigate,
}: {
  adjacent: AdjacentTab;
  side: 'left' | 'right';
  onNavigate: (tabId: string, direction: 'left' | 'right') => void;
}) {
  const { t } = useI18n();
  const Icon = side === 'left' ? ChevronLeft : ChevronRight;
  const shortcutId = side === 'left' ? 'prev-tab' : 'next-tab';
  const shortcutLabel = side === 'left' ? t('shortcut.prevTab') : t('shortcut.nextTab');

  return (
    <ShortcutTooltip id={shortcutId} label={shortcutLabel}>
      <button
        type="button"
        aria-label={shortcutLabel}
        className="group relative flex items-center cursor-pointer border-0 bg-transparent p-0 text-inherit"
        onClick={() => onNavigate(adjacent.tabId, side)}
        data-testid={`tab-carousel-${side}-nav`}
      >
        {/* Frosted glass circle */}
        <div
          className={cn(
            'flex items-center justify-center',
            'w-10 h-10 rounded-full',
            'bg-(--chat-bg)/50 backdrop-blur-md',
            'border border-(--divider)/40',
            'shadow-[0_1px_4px_rgba(0,0,0,.03)]',
            'text-(--text-primary)',
            'opacity-40',
            'group-hover:opacity-100',
            'group-hover:bg-(--chat-bg)/90 group-hover:border-(--accent)/40',
            'group-hover:text-(--accent)',
            'group-hover:shadow-[0_3px_16px_rgba(0,0,0,.08)]',
            'group-hover:scale-105',
            'transition-all duration-200 ease-out',
          )}
        >
          <Icon size={18} strokeWidth={1.5} />
        </div>

        {/* Title tooltip — slides out on hover */}
        <div
          className={cn(
            'absolute flex items-center',
            'px-2.5 py-1 rounded-md',
            'bg-(--chat-bg)/95 backdrop-blur-sm',
            'border border-(--divider)/60',
            'shadow-[0_2px_12px_rgba(0,0,0,.08)]',
            'opacity-0 pointer-events-none',
            'group-hover:opacity-100 group-hover:pointer-events-auto',
            'transition-all duration-200 ease-out',
            side === 'left'
              ? 'right-[calc(100%+6px)] group-hover:right-[calc(100%+8px)]'
              : 'left-[calc(100%+6px)] group-hover:left-[calc(100%+8px)]',
          )}
        >
          <span className="text-[0.6875rem] whitespace-nowrap max-w-[140px] truncate text-(--text-secondary)">
            <SideNavTitle sessionId={adjacent.sessionId} fallbackTitle={adjacent.title} />
          </span>
        </div>
      </button>
    </ShortcutTooltip>
  );
});

// ---------------------------------------------------------------------------
// Sub-component: EdgeOverlay — in-DOM overlay for multi-panel mode
// ---------------------------------------------------------------------------

const EdgeOverlay = memo(function EdgeOverlay({
  adjacent,
  side,
  onNavigate,
  activeIndex,
  totalTabs,
}: {
  adjacent: AdjacentTab;
  side: 'left' | 'right';
  onNavigate: (tabId: string, direction: 'left' | 'right') => void;
  activeIndex: number;
  totalTabs: number;
}) {
  const { t } = useI18n();
  const shortcutId = side === 'left' ? 'prev-tab' : 'next-tab';
  const shortcutLabel = side === 'left' ? t('shortcut.prevTab') : t('shortcut.nextTab');

  // Build dot array: show up to 5 dots max (truncate for many tabs)
  const maxDots = Math.min(totalTabs, 5);
  const dots = Array.from({ length: maxDots }, (_, i) => i);

  return (
    <div
      className={cn(
        'absolute top-1/2 -translate-y-1/2 pointer-events-auto',
        side === 'left' ? 'left-1' : 'right-1',
      )}
    >
      <ShortcutTooltip id={shortcutId} label={shortcutLabel}>
        <button
          type="button"
          aria-label={shortcutLabel}
          className="group cursor-pointer flex flex-col items-center gap-[5px] border-0 bg-transparent px-0 py-2 text-inherit"
          onClick={() => onNavigate(adjacent.tabId, side)}
          data-testid={`tab-carousel-${side}-nav`}
        >
          {/* Pagination dots */}
          {dots.map((i) => (
            <div
              key={i}
              className={cn(
                'rounded-full transition-all duration-200',
                i === activeIndex
                  ? 'w-1.5 h-3.5 bg-(--accent) rounded-[3px]'
                  : 'w-1.5 h-1.5 opacity-50',
                i !== activeIndex && (
                  i === (side === 'right' ? activeIndex + 1 : activeIndex - 1)
                    ? 'bg-(--accent) group-hover:opacity-100 group-hover:shadow-[0_0_4px_var(--accent)]'
                    : 'bg-(--text-muted)'
                ),
              )}
            />
          ))}

          {/* Tooltip on hover */}
          <div
            className={cn(
              'absolute top-1/2 -translate-y-1/2',
              'flex items-center gap-1.5 px-2.5 py-1.5 rounded-md',
              'bg-(--chat-header-bg) border border-(--divider)',
              'shadow-[0_4px_16px_rgba(0,0,0,.3)] backdrop-blur-sm',
              'whitespace-nowrap opacity-0 pointer-events-none',
              'transition-all duration-200',
              'group-hover:opacity-100',
              side === 'left'
                ? 'left-[calc(100%+6px)] group-hover:translate-x-0 translate-x-[-4px]'
                : 'right-[calc(100%+6px)] group-hover:translate-x-0 translate-x-[4px]',
            )}
          >
            <span className="text-[0.6875rem] font-medium text-(--accent)">
              <SideNavTitle sessionId={adjacent.sessionId} fallbackTitle={adjacent.title} />
            </span>
          </div>
        </button>
      </ShortcutTooltip>
    </div>
  );
});

// ---------------------------------------------------------------------------
// Main component: TabCarouselNav
// ---------------------------------------------------------------------------

export const TabCarouselNav = memo(function TabCarouselNav({
  children,
}: {
  children: React.ReactNode;
}) {
  const { left, right, activeIndex, totalTabs } = useAdjacentTabs();
  const isSinglePanel = usePanelStore((s) => Object.keys(selectActiveTab(s)?.panels ?? EMPTY_PANELS).length <= 1);
  const [slideClass, setSlideClass] = useState<string | null>(null);
  const animTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Measure the 960px content area for portal positioning
  const needsPortal = isSinglePanel && !!(left || right);
  const { contentRef, containerRef, edges } = useContentEdges(needsPortal);

  const handleNavigate = useCallback((tabId: string, direction: 'left' | 'right') => {
    // Trigger slide animation
    setSlideClass(direction === 'left' ? 'carousel-slide-right' : 'carousel-slide-left');

    if (animTimerRef.current) clearTimeout(animTimerRef.current);
    animTimerRef.current = setTimeout(() => {
      setSlideClass(null);
      animTimerRef.current = null;
    }, SLIDE_DURATION);

    useTabStore.getState().setActiveTab(tabId);
  }, []);

  // Determine if margins are wide enough for portal pills
  const showLeftPortal = edges && edges.marginLeft >= MIN_MARGIN_PX;
  const showRightPortal = edges && edges.marginRight >= MIN_MARGIN_PX;

  return (
    <div ref={containerRef} className={cn('flex-1 flex flex-col overflow-hidden relative', slideClass)}>
      {children}

      {/* Invisible measurement element — matches content area bounds */}
      {needsPortal && (
        <div
          ref={contentRef}
          className="absolute inset-0 pointer-events-none"
          style={{ maxWidth: 960, margin: '0 auto' }}
        />
      )}

      {/* Multi-panel: edge overlays (in-DOM, absolute) */}
      {!isSinglePanel && (left || right) && (
        <div className="absolute inset-0 pointer-events-none z-30">
          <div className="relative h-full w-full">
            {left && <EdgeOverlay adjacent={left} side="left" onNavigate={handleNavigate} activeIndex={activeIndex} totalTabs={totalTabs} />}
            {right && <EdgeOverlay adjacent={right} side="right" onNavigate={handleNavigate} activeIndex={activeIndex} totalTabs={totalTabs} />}
          </div>
        </div>
      )}

      {/* Single-panel: portal-rendered pills in the margin area */}
      {isSinglePanel && edges && typeof document !== 'undefined' && createPortal(
        <>
          {left && showLeftPortal && (
            <div
              style={{
                position: 'fixed',
                top: edges.top,
                right: `calc(100vw - ${edges.left}px + ${edges.marginLeft / 2}px)`,
                height: edges.height,
                display: 'flex',
                alignItems: 'center',
                zIndex: 40,
                pointerEvents: 'none',
              }}
            >
              <div style={{ pointerEvents: 'auto' }}>
                <ContentPill adjacent={left} side="left" onNavigate={handleNavigate} />
              </div>
            </div>
          )}
          {right && showRightPortal && (
            <div
              style={{
                position: 'fixed',
                top: edges.top,
                left: edges.right + edges.marginRight / 2,
                height: edges.height,
                display: 'flex',
                alignItems: 'center',
                zIndex: 40,
                pointerEvents: 'none',
              }}
            >
              <div style={{ pointerEvents: 'auto' }}>
                <ContentPill adjacent={right} side="right" onNavigate={handleNavigate} />
              </div>
            </div>
          )}
        </>,
        document.body,
      )}
    </div>
  );
});
