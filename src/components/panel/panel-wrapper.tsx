'use client';

import { memo, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import { usePanelStore, TabIdContext, EMPTY_PANELS } from '@/stores/panel-store';
import { useSessionStore } from '@/stores/session-store';
import { toast, useNotificationStore } from '@/stores/notification-store';
import { useTabStore } from '@/stores/tab-store';
import { useSessionNavigation } from '@/hooks/use-session-navigation';
import { wsClient } from '@/lib/ws/client';
import { PanelDropZone, type DropEdge } from './panel-drop-zone';
import { PANEL_NODE_DRAG_MIME, SESSION_DRAG_MIME, TAB_DRAG_MIME, TAB_PANEL_TREE_DND_MIME } from '@/types/panel';
import { useSettingsStore } from '@/stores/settings-store';
import { useI18n } from '@/lib/i18n';
import {
  getWorkspaceFileDragAbsolutePath,
  hasWorkspaceFileDragData,
  isPathInsertOnlyDragData,
  parsePanelNodeDragData,
  parsePanelTitleDragData,
} from '@/lib/dnd/panel-session-drag';
import {
  insertFilePathIntoTerminal,
  resolvePanelTerminalId,
} from '@/lib/terminal/terminal-file-path-insert';
import {
  getNativeFileDropAbsolutePaths,
  isNativeFileDrag,
} from '@/lib/dnd/native-file-drop';
import { focusPanelControl } from '@/lib/session/focus-session-panel';

/** Edge zone threshold — the outer 25% of each edge triggers a split. */
const EDGE_THRESHOLD = 0.25;
const MIN_PANEL_WIDTH = 250;
const MIN_PANEL_HEIGHT = 150;

/**
 * Compute which zone the cursor is in within a panel.
 * Outer 25% from each edge → split zone (left/right/top/bottom).
 * Inner area → center zone (replace/assign).
 * Left/right take priority over top/bottom for ambiguous corners.
 */
function computeDropEdge(clientX: number, clientY: number, rect: DOMRect): DropEdge {
  const x = (clientX - rect.left) / rect.width;
  const y = (clientY - rect.top) / rect.height;

  const distLeft = x;
  const distRight = 1 - x;
  const distTop = y;
  const distBottom = 1 - y;

  const minEdgeDist = Math.min(distLeft, distRight, distTop, distBottom);

  // If cursor is in the inner area (far from all edges), it's center
  if (minEdgeDist >= EDGE_THRESHOLD) return 'center';

  // Otherwise, determine which edge is closest
  if (minEdgeDist === distLeft) return 'left';
  if (minEdgeDist === distRight) return 'right';
  if (minEdgeDist === distTop) return 'top';
  return 'bottom';
}

interface PanelWrapperProps {
  panelId: string;
  children: React.ReactNode;
}

export const PanelWrapper = memo(function PanelWrapper({ panelId, children }: PanelWrapperProps) {
  const { t } = useI18n();
  const tabId = useContext(TabIdContext);
  const isActive = usePanelStore((s) => (
    s.activeTabId === tabId && s.tabPanels[tabId]?.activePanelId === panelId
  ));
  const isSinglePanel = usePanelStore((s) => Object.keys(s.tabPanels[tabId]?.panels ?? EMPTY_PANELS).length <= 1);
  const setActivePanelId = usePanelStore((s) => s.setActivePanelId);
  const inactivePanelDimming = useSettingsStore((s) => s.settings.inactivePanelDimming);

  const { viewSession } = useSessionNavigation();

  // --- DnD state ---
  const [dropEdge, setDropEdge] = useState<DropEdge | null>(null);
  const [insertPathHint, setInsertPathHint] = useState(false);
  const dropEdgeRef = useRef<DropEdge | null>(null);
  const dragCounterRef = useRef(0);
  const wrapperRef = useRef<HTMLDivElement>(null);

  // REQ-5: get sessionId for unread clearing
  const sessionId = usePanelStore((s) => s.tabPanels[tabId]?.panels[panelId]?.sessionId ?? null);
  const sessionUnreadCount = useSessionStore((state) => {
    if (!sessionId) return 0;
    for (const project of state.projects) {
      const session = project.sessions.find((item) => item.id === sessionId);
      if (session) return session.unreadCount ?? 0;
    }
    return 0;
  });

  // REQ-5: Clear unread count when this panel becomes active
  useEffect(() => {
    if (!isActive || !sessionId || sessionUnreadCount <= 0) return;
    useSessionStore.getState().clearUnreadCount(sessionId);
    useNotificationStore.getState().markSessionAsRead(sessionId);
    wsClient.sendMarkAsRead(sessionId);
  }, [isActive, sessionId, sessionUnreadCount]);

  // 패널 활성화 시 포커스 자동 이동
  useEffect(() => {
    if (!isActive) return;
    focusPanelControl(panelId);
  }, [isActive, panelId, sessionId]);

  const handleMouseDown = useCallback(() => {
    const ps = usePanelStore.getState();
    if (ps.tabPanels[ps.activeTabId]?.activePanelId !== panelId) {
      setActivePanelId(panelId);
    }
  }, [setActivePanelId, panelId]);

  // --- DnD handlers ---

  /**
   * A workspace file/folder dragged onto the center of a terminal pane inserts
   * its path into the prompt (Orca-style) instead of replacing the pane. Edge
   * drops keep the existing split-into-file-viewer behavior for files;
   * folders are insert-only and never split.
   */
  const resolveInsertTargetTerminalId = useCallback(() => {
    const ps = usePanelStore.getState();
    const panel = ps.tabPanels[ps.activeTabId]?.panels[panelId];
    return resolvePanelTerminalId(panel, (id) => (
      useSessionStore.getState().getSession(id)?.kind === 'terminal'
    ));
  }, [panelId]);

  const isTerminalPathInsertTarget = useCallback((e: React.DragEvent) => (
    hasWorkspaceFileDragData(e.dataTransfer) && resolveInsertTargetTerminalId() !== null
  ), [resolveInsertTargetTerminalId]);

  // OS (Finder/Explorer) file drops behave like folder drags: insert-only,
  // center-only, and accepted only over a terminal pane.
  const isNativeFilePathInsertTarget = useCallback((e: React.DragEvent) => (
    isNativeFileDrag(e.dataTransfer) && resolveInsertTargetTerminalId() !== null
  ), [resolveInsertTargetTerminalId]);

  const isPanelCompatibleDrag = useCallback((e: React.DragEvent) => {
    // OS file drags carry the synthetic 'Files' type and no in-app payload;
    // accept only over a terminal pane, where the drop inserts the path.
    if (isNativeFileDrag(e.dataTransfer)) return isNativeFilePathInsertTarget(e);
    // Insert-only drags (folders) carry no session payload — accept them only
    // over a terminal pane, where the drop inserts the path.
    if (isPathInsertOnlyDragData(e.dataTransfer)) return isTerminalPathInsertTarget(e);
    const hasSessionDrag = e.dataTransfer.types.includes(SESSION_DRAG_MIME);
    const hasTabPanelTreeDrag = e.dataTransfer.types.includes(TAB_PANEL_TREE_DND_MIME);
    const hasPanelNodeDrag = e.dataTransfer.types.includes(PANEL_NODE_DRAG_MIME);
    if (!hasSessionDrag && !hasTabPanelTreeDrag && !hasPanelNodeDrag) return false;
    if (hasTabPanelTreeDrag && e.dataTransfer.getData(TAB_PANEL_TREE_DND_MIME) === tabId) return false;
    if (hasPanelNodeDrag) {
      const nodeDrag = parsePanelNodeDragData(e.dataTransfer);
      if (nodeDrag?.tabId === tabId && nodeDrag.panelId === panelId) return false;
    }
    // Yield to session-ref drop zone (MessageInput) — let it handle the drop
    if (hasSessionDrag && (e.target as HTMLElement)?.closest?.('[data-session-ref-drop]')) return false;
    return true;
  }, [panelId, tabId, isTerminalPathInsertTarget, isNativeFilePathInsertTarget]);

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    if (!isPanelCompatibleDrag(e)) return;
    e.preventDefault();
    dragCounterRef.current++;
  }, [isPanelCompatibleDrag]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    if (!isPanelCompatibleDrag(e)) return;
    e.preventDefault();
    const isNativeFile = isNativeFileDrag(e.dataTransfer);
    e.dataTransfer.dropEffect = isNativeFile ? 'copy' : 'move';

    const rect = wrapperRef.current?.getBoundingClientRect();
    if (!rect) return;

    // Insert-only drags (folders, OS files) have no split behavior, so the
    // whole pane acts as center.
    const edge = isNativeFile || isPathInsertOnlyDragData(e.dataTransfer)
      ? 'center'
      : computeDropEdge(e.clientX, e.clientY, rect);
    dropEdgeRef.current = edge;
    setDropEdge(edge);
    setInsertPathHint(
      edge === 'center' &&
      (isNativeFile ? isNativeFilePathInsertTarget(e) : isTerminalPathInsertTarget(e)),
    );
  }, [isPanelCompatibleDrag, isTerminalPathInsertTarget, isNativeFilePathInsertTarget]);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    if (!isPanelCompatibleDrag(e)) return;
    e.preventDefault();
    dragCounterRef.current--;
    if (dragCounterRef.current <= 0) {
      dragCounterRef.current = 0;
      dropEdgeRef.current = null;
      setDropEdge(null);
      setInsertPathHint(false);
    }
  }, [isPanelCompatibleDrag]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const currentEdge = dropEdgeRef.current;
    dragCounterRef.current = 0;
    dropEdgeRef.current = null;
    setDropEdge(null);
    setInsertPathHint(false);

    // OS (Finder/Explorer) file drop → insert each absolute path into the PTY.
    if (currentEdge === 'center' && isNativeFilePathInsertTarget(e)) {
      const targetTerminalId = resolveInsertTargetTerminalId();
      const paths = getNativeFileDropAbsolutePaths(e.dataTransfer);
      if (targetTerminalId && paths.length > 0) {
        let inserted = false;
        for (const path of paths) {
          if (insertFilePathIntoTerminal(targetTerminalId, path)) inserted = true;
        }
        if (inserted) {
          usePanelStore.getState().setActivePanelId(panelId);
          focusPanelControl(panelId);
        }
      }
      return;
    }

    if (currentEdge === 'center' && isTerminalPathInsertTarget(e)) {
      const filePath = getWorkspaceFileDragAbsolutePath(e.dataTransfer);
      const targetTerminalId = resolveInsertTargetTerminalId();
      if (filePath && targetTerminalId && insertFilePathIntoTerminal(targetTerminalId, filePath)) {
        usePanelStore.getState().setActivePanelId(panelId);
        focusPanelControl(panelId);
      }
      return;
    }

    const droppedSessionId = e.dataTransfer.getData(SESSION_DRAG_MIME);
    const droppedTabTreeId = e.dataTransfer.getData(TAB_PANEL_TREE_DND_MIME);
    const panelNodeDrag = parsePanelNodeDragData(e.dataTransfer);
    const panelTitleDrag = parsePanelTitleDragData(e.dataTransfer);
    if (!currentEdge || (!droppedSessionId && !droppedTabTreeId && !panelNodeDrag)) return;
    const isTabDrag = e.dataTransfer.types.includes(TAB_DRAG_MIME);

    // Read fresh state for sessionId (avoid stale closure)
    const freshPs = usePanelStore.getState();
    const currentSessionId = freshPs.tabPanels[freshPs.activeTabId]?.panels[panelId]?.sessionId ?? null;

    const sourceTabData = droppedTabTreeId ? freshPs.tabPanels[droppedTabTreeId] : undefined;
    if (droppedTabTreeId === freshPs.activeTabId) return;
    if (droppedTabTreeId && sourceTabData) {
      const isEdgeSplit = currentEdge !== 'center';
      if (isEdgeSplit) {
        const rect = wrapperRef.current?.getBoundingClientRect();
        if (!rect) return;

        const isHorizontalSplit = currentEdge === 'left' || currentEdge === 'right';
        const nextPaneSize = isHorizontalSplit ? rect.width / 2 : rect.height / 2;
        const minPaneSize = isHorizontalSplit ? MIN_PANEL_WIDTH : MIN_PANEL_HEIGHT;
        if (nextPaneSize < minPaneSize) {
          toast.warning(t('panel.tooSmallToSplit'));
          return;
        }
      }

      const graftedActivePanelId = freshPs.graftTabIntoActiveTab(droppedTabTreeId, panelId, currentEdge);
      if (!graftedActivePanelId) return;

      const tabStore = useTabStore.getState();
      tabStore.closeTab(droppedTabTreeId);
      tabStore.pinTab(tabStore.activeTabId);

      const nextPanelStore = usePanelStore.getState();
      const nextTabData = nextPanelStore.tabPanels[nextPanelStore.activeTabId];
      const nextSessionId = nextTabData?.panels[graftedActivePanelId]?.sessionId ?? null;
      const session = nextSessionId ? useSessionStore.getState().getSession(nextSessionId) : null;
      if (session) {
        viewSession(session, { forceReload: true });
      }
      return;
    }

    // No-op if dropped on the same panel that already has this session
    if (droppedSessionId && currentSessionId === droppedSessionId) return;

    const isEdgeSplit = currentEdge !== 'center';
    if (isEdgeSplit) {
      const rect = wrapperRef.current?.getBoundingClientRect();
      if (!rect) return;

      const isHorizontalSplit = currentEdge === 'left' || currentEdge === 'right';
      const nextPaneSize = isHorizontalSplit ? rect.width / 2 : rect.height / 2;
      const minPaneSize = isHorizontalSplit ? MIN_PANEL_WIDTH : MIN_PANEL_HEIGHT;
      if (nextPaneSize < minPaneSize) {
        toast.warning(t('panel.tooSmallToSplit'));
        return;
      }
    }

    const currentTabId = useTabStore.getState().activeTabId;
    const isPanelTitleDrag =
      panelTitleDrag?.sessionId === droppedSessionId &&
      panelTitleDrag.tabId === currentTabId &&
      panelTitleDrag.panelId !== panelId;

    if (isPanelTitleDrag) {
      const panelStore = usePanelStore.getState();
      const sourcePanelId = panelTitleDrag.panelId;
      const sourceTabData = panelStore.tabPanels[currentTabId];
      if (!sourceTabData?.panels[sourcePanelId]) return;

      if (currentEdge === 'center') {
        if (currentSessionId) {
          panelStore.assignSession(panelId, null);
          panelStore.assignSession(sourcePanelId, currentSessionId);
          panelStore.assignSession(panelId, droppedSessionId);
        } else {
          panelStore.assignSession(sourcePanelId, null);
          panelStore.assignSession(panelId, droppedSessionId);
        }

        usePanelStore.getState().setActivePanelId(panelId);
        useTabStore.getState().pinTab(currentTabId);

        const session = useSessionStore.getState().getSession(droppedSessionId);
        if (session) {
          viewSession(session, { forceReload: true });
        }
        return;
      }

      if (Object.keys(sourceTabData.panels).length > 1) {
        panelStore.closePanel(sourcePanelId);
      } else {
        panelStore.assignSession(sourcePanelId, null);
      }

      const direction: 'horizontal' | 'vertical' =
        currentEdge === 'left' || currentEdge === 'right' ? 'horizontal' : 'vertical';
      const position: 'before' | 'after' =
        currentEdge === 'left' || currentEdge === 'top' ? 'before' : 'after';
      const newPanelId = usePanelStore.getState().splitPanel(panelId, direction, droppedSessionId, position);
      if (newPanelId) {
        useTabStore.getState().pinTab(currentTabId);
      }

      const session = useSessionStore.getState().getSession(droppedSessionId);
      if (session) {
        viewSession(session, { forceReload: true });
      }
      return;
    }

    const isPanelNodeDrag =
      panelNodeDrag?.tabId === currentTabId &&
      panelNodeDrag.panelId !== panelId &&
      !isPanelTitleDrag;

    if (isPanelNodeDrag) {
      const panelStore = usePanelStore.getState();
      const sourcePanelId = panelNodeDrag.panelId;
      const sourceTabData = panelStore.tabPanels[currentTabId];
      if (!sourceTabData?.panels[sourcePanelId]) return;

      const movedPanelId = panelStore.movePanelNode(sourcePanelId, panelId, currentEdge);
      if (movedPanelId) {
        useTabStore.getState().pinTab(currentTabId);
        const nextTabData = usePanelStore.getState().tabPanels[currentTabId];
        const movedSessionId = nextTabData?.panels[movedPanelId]?.sessionId ?? null;
        const session = movedSessionId ? useSessionStore.getState().getSession(movedSessionId) : null;
        if (session) {
          viewSession(session, { forceReload: true });
        }
      }
      return;
    }

    // Move semantics: clear session from source.
    if (!droppedSessionId) return;
    const location = useTabStore.getState().findSessionLocation(droppedSessionId);
    if (location) {
      if (location.tabId === currentTabId) {
        // Same tab — clear the source panel
        usePanelStore.getState().assignSession(location.panelId, null);
      } else {
        const sourceTabData = usePanelStore.getState().tabPanels[location.tabId];
        const sourceSessionCount = Object.values(sourceTabData?.panels ?? {})
          .filter((panel) => panel.sessionId !== null)
          .length;

        if (isTabDrag && sourceSessionCount > 1) {
          usePanelStore.getState().assignSessionInTab(location.tabId, location.panelId, null);
        } else {
          // Cross-tab single-session move keeps existing tab drag behavior.
          useTabStore.getState().closeTab(location.tabId);
        }
      }
    }

    // Re-read fresh state after source-clearing mutation
    const freshState = usePanelStore.getState();
    if (currentEdge === 'center') {
      // Center zone — replace/assign session (no split)
      freshState.assignSession(panelId, droppedSessionId);
    } else {
      // Edge zone — split the target panel, including empty panels.
      const direction: 'horizontal' | 'vertical' =
        currentEdge === 'left' || currentEdge === 'right' ? 'horizontal' : 'vertical';
      const position: 'before' | 'after' =
        currentEdge === 'left' || currentEdge === 'top' ? 'before' : 'after';
      const newPanelId = freshState.splitPanel(panelId, direction, droppedSessionId, position);
      if (newPanelId) {
        const tabStore = useTabStore.getState();
        tabStore.pinTab(tabStore.activeTabId);
      }
    }

    // Load session history
    const session = useSessionStore.getState().getSession(droppedSessionId);
    if (session) {
      viewSession(session, { forceReload: true });
    }
  }, [panelId, t, viewSession, isTerminalPathInsertTarget, isNativeFilePathInsertTarget, resolveInsertTargetTerminalId]);

  return (
    <div
      ref={wrapperRef}
      data-panel-wrapper="true"
      data-panel-id={panelId}
      data-active={String(isActive)}
      data-testid="panel-wrapper"
      className={cn(
        'relative flex h-full w-full min-h-0 min-w-0 flex-col overflow-hidden border transition-opacity duration-150',
        isSinglePanel
          ? 'border-transparent'
          : 'border-(--divider)'
      )}
      style={
        !isSinglePanel && !isActive
          ? { opacity: 1 - (inactivePanelDimming / 100) * 0.6 }
          : undefined
      }
      onMouseDown={handleMouseDown}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {children}
      {dropEdge && (
        <PanelDropZone
          edge={dropEdge}
          label={insertPathHint ? t('panel.dropToInsertPath') : undefined}
        />
      )}
    </div>
  );
});
