import { create } from 'zustand';
import { createContext } from 'react';
import { v4 as uuidv4 } from 'uuid';
import type { Panel, PanelDropEdge, PanelNode, PanelStore, PanelStoreState, TabPanelData } from '@/types/panel';
import { useSessionStore } from '@/stores/session-store';

export const EMPTY_PANELS: Record<string, Panel> = Object.freeze({});

// --- 순수 함수 헬퍼 (export 없음, side effect 없음) ---

function replaceLeafInTree(node: PanelNode, targetId: string, replacement: PanelNode): PanelNode {
  if (node.type === 'leaf') {
    return node.panelId === targetId ? replacement : node;
  }
  const newLeft = replaceLeafInTree(node.children[0], targetId, replacement);
  const newRight = replaceLeafInTree(node.children[1], targetId, replacement);
  if (newLeft === node.children[0] && newRight === node.children[1]) return node;
  return { ...node, children: [newLeft, newRight] };
}

function removePanelFromTree(node: PanelNode, targetId: string): PanelNode | null {
  if (node.type === 'leaf') return node.panelId === targetId ? null : node;
  const left = removePanelFromTree(node.children[0], targetId);
  const right = removePanelFromTree(node.children[1], targetId);
  if (left === null) return right;
  if (right === null) return left;
  return { ...node, children: [left, right] };
}

function updateRatioInTree(node: PanelNode, leftAnchor: string, rightAnchor: string, ratio: number): PanelNode {
  if (node.type === 'leaf') return node;
  // 좌우 자식의 firstLeaf 쌍으로 split 노드를 고유 식별.
  // 2x2에서 루트 hsplit(A,C)과 왼쪽 vsplit(A,B)이 구분됨.
  if (findFirstLeafId(node.children[0]) === leftAnchor && findFirstLeafId(node.children[1]) === rightAnchor) {
    return { ...node, ratio: Math.max(0.15, Math.min(0.85, ratio)) };
  }
  const newLeft = updateRatioInTree(node.children[0], leftAnchor, rightAnchor, ratio);
  const newRight = updateRatioInTree(node.children[1], leftAnchor, rightAnchor, ratio);
  if (newLeft === node.children[0] && newRight === node.children[1]) return node;
  return { ...node, children: [newLeft, newRight] };
}

function findFirstLeafId(node: PanelNode): string {
  if (node.type === 'leaf') return node.panelId;
  return findFirstLeafId(node.children[0]);
}

function collectLeafIds(node: PanelNode): string[] {
  if (node.type === 'leaf') return [node.panelId];
  return [...collectLeafIds(node.children[0]), ...collectLeafIds(node.children[1])];
}

function containsLeaf(node: PanelNode, panelId: string): boolean {
  if (node.type === 'leaf') return node.panelId === panelId;
  return containsLeaf(node.children[0], panelId) || containsLeaf(node.children[1], panelId);
}

function remapPanelNode(node: PanelNode, panelIdMap: Map<string, string>): PanelNode | null {
  if (node.type === 'leaf') {
    const nextPanelId = panelIdMap.get(node.panelId);
    return nextPanelId ? { type: 'leaf', panelId: nextPanelId } : null;
  }

  const left = remapPanelNode(node.children[0], panelIdMap);
  const right = remapPanelNode(node.children[1], panelIdMap);
  if (!left || !right) return null;

  return { ...node, children: [left, right] };
}

function cloneTabPanelTree(tabData: TabPanelData): TabPanelData | null {
  const leafIds = collectLeafIds(tabData.layout);
  if (leafIds.length === 0) return null;

  const panelIdMap = new Map<string, string>();
  for (const panelId of leafIds) {
    if (!tabData.panels[panelId]) return null;
    panelIdMap.set(panelId, uuidv4());
  }

  const layout = remapPanelNode(tabData.layout, panelIdMap);
  if (!layout) return null;

  const panels: Record<string, Panel> = {};
  for (const oldPanelId of leafIds) {
    const newPanelId = panelIdMap.get(oldPanelId);
    const oldPanel = tabData.panels[oldPanelId];
    if (!newPanelId || !oldPanel) return null;
    panels[newPanelId] = {
      id: newPanelId,
      sessionId: oldPanel.sessionId,
      terminalId: oldPanel.terminalId ?? null,
      terminalSessionId: oldPanel.terminalSessionId ?? null,
    };
  }

  const activePanelId = panelIdMap.get(tabData.activePanelId) ?? findFirstLeafId(layout);
  return { layout, panels, activePanelId };
}

function buildSplitNode(
  existingLeaf: PanelNode,
  graftedNode: PanelNode,
  edge: Exclude<PanelDropEdge, 'center'>,
): PanelNode {
  const position = edge === 'left' || edge === 'top' ? 'before' : 'after';

  return {
    type: edge === 'left' || edge === 'right' ? 'hsplit' : 'vsplit',
    children: position === 'before'
      ? [graftedNode, existingLeaf]
      : [existingLeaf, graftedNode],
    ratio: 0.5,
  };
}

function replaceLeafWithExistingLeaf(node: PanelNode, sourcePanelId: string, targetPanelId: string): PanelNode {
  if (node.type === 'leaf') {
    return node.panelId === targetPanelId ? { type: 'leaf', panelId: sourcePanelId } : node;
  }

  const newLeft = replaceLeafWithExistingLeaf(node.children[0], sourcePanelId, targetPanelId);
  const newRight = replaceLeafWithExistingLeaf(node.children[1], sourcePanelId, targetPanelId);
  if (newLeft === node.children[0] && newRight === node.children[1]) return node;
  return { ...node, children: [newLeft, newRight] };
}

// --- 개발 환경 불변 조건 검증 ---

function assertInvariants(tabData: TabPanelData): void {
  if (process.env.NODE_ENV !== 'development') return;

  // 불변 조건 1: activePanelId는 panels에 존재해야 함
  if (!tabData.panels[tabData.activePanelId]) {
    console.error('[panel-store] INVARIANT VIOLATION: activePanelId not in panels', {
      activePanelId: tabData.activePanelId,
      panelIds: Object.keys(tabData.panels),
    });
  }

  // 불변 조건 2: layout 트리 리프 수와 panels 크기 일치
  const leafIds = collectLeafIds(tabData.layout);
  const panelIds = Object.keys(tabData.panels);
  if (leafIds.length !== panelIds.length) {
    console.error('[panel-store] INVARIANT VIOLATION: layout-panels size mismatch', {
      leafIds,
      panelIds,
    });
  }

  // 불변 조건 3: orphan panel 없음
  const orphanPanels = panelIds.filter(id => !leafIds.includes(id));
  if (orphanPanels.length > 0) {
    console.error('[panel-store] INVARIANT VIOLATION: orphan panels detected', { orphanPanels });
  }
}

// --- TabIdContext & selectActiveTab ---

export const TabIdContext = createContext<string>('');

export function selectActiveTab(s: PanelStoreState): TabPanelData | undefined {
  return s.tabPanels[s.activeTabId];
}

// --- 스토어 생성 ---

export const usePanelStore = create<PanelStore>()((set, get) => ({
  // 초기 상태 — 빈 tabPanels, activeTabId는 빈 문자열 (tab-store가 initTab으로 채움)
  tabPanels: {},
  activeTabId: '',

  // --- 탭 관리 액션 ---

  initTab: (tabId, data) => {
    set((state) => ({
      tabPanels: { ...state.tabPanels, [tabId]: data },
    }));
  },

  removeTab: (tabId) => {
    set((state) => {
      const { [tabId]: _, ...rest } = state.tabPanels;
      return { tabPanels: rest };
    });
  },

  setActiveTabId: (tabId) => {
    set({ activeTabId: tabId });
    const tabData = get().tabPanels[tabId];
    if (tabData) {
      const sessionId = tabData.panels[tabData.activePanelId]?.sessionId ?? null;
      useSessionStore.getState().setActiveSession(sessionId);
    }
  },

  getTabPanelData: (tabId) => get().tabPanels[tabId],

  // --- 기존 액션 (activeTabId의 탭 데이터에 대해 동작) ---

  initializeWithSession: (sessionId) => {
    const state = get();
    const tabData = state.tabPanels[state.activeTabId];
    if (!tabData) return;

    const activePanel = tabData.panels[tabData.activePanelId];
    if (!activePanel) return;

    set({
      tabPanels: {
        ...state.tabPanels,
        [state.activeTabId]: {
          ...tabData,
          panels: {
            ...tabData.panels,
            [tabData.activePanelId]: { ...activePanel, sessionId },
          },
        },
      },
    });

    useSessionStore.getState().setActiveSession(sessionId);
  },

  splitPanel: (panelId, direction, newSessionId, position = 'after') => {
    const state = get();
    const tabData = state.tabPanels[state.activeTabId];
    if (!tabData) return null;

    // Guard 1: 패널 존재 확인
    if (!tabData.panels[panelId]) return null;

    // Guard 2: orphan panel 방지
    if (!containsLeaf(tabData.layout, panelId)) return null;

    const newPanelId = uuidv4();
    const newPanel: Panel = { id: newPanelId, sessionId: newSessionId ?? null };
    const existingLeaf: PanelNode = { type: 'leaf', panelId };
    const newLeaf: PanelNode = { type: 'leaf', panelId: newPanelId };
    const splitNode: PanelNode = {
      type: direction === 'horizontal' ? 'hsplit' : 'vsplit',
      children: position === 'before'
        ? [newLeaf, existingLeaf]
        : [existingLeaf, newLeaf],
      ratio: 0.5,
    };
    const newLayout = replaceLeafInTree(tabData.layout, panelId, splitNode);

    const newTabData: TabPanelData = {
      panels: { ...tabData.panels, [newPanelId]: newPanel },
      layout: newLayout,
      activePanelId: newPanelId,
    };

    // 단일 set() 호출 (PATTERN-PERF-03)
    set({
      tabPanels: {
        ...state.tabPanels,
        [state.activeTabId]: newTabData,
      },
    });

    assertInvariants(newTabData);

    // session-store 동기화
    useSessionStore.getState().setActiveSession(newSessionId ?? null);

    return newPanelId;
  },

  createTerminalPanel: (panelId, terminalId, direction = 'vertical') => {
    const state = get();
    const tabData = state.tabPanels[state.activeTabId];
    if (!tabData) return null;
    const activePanel = tabData.panels[panelId];
    if (!activePanel) return null;

    if (activePanel.sessionId === null && !activePanel.terminalId) {
      get().assignTerminal(panelId, terminalId, activePanel.sessionId);
      return panelId;
    }

    const newPanelId = get().splitPanel(panelId, direction, null);
    if (!newPanelId) return null;
    get().assignTerminal(newPanelId, terminalId, activePanel.sessionId);
    return newPanelId;
  },

  movePanelNode: (sourcePanelId, targetPanelId, edge) => {
    const state = get();
    const tabData = state.tabPanels[state.activeTabId];
    if (!tabData) return null;
    if (sourcePanelId === targetPanelId) return null;

    const sourcePanel = tabData.panels[sourcePanelId];
    const targetPanel = tabData.panels[targetPanelId];
    if (!sourcePanel || !targetPanel) return null;
    if (!containsLeaf(tabData.layout, sourcePanelId) || !containsLeaf(tabData.layout, targetPanelId)) return null;

    if (edge === 'center') {
      const nextPanels = {
        ...tabData.panels,
        [sourcePanelId]: {
          ...sourcePanel,
          sessionId: targetPanel.sessionId,
          terminalId: targetPanel.terminalId ?? null,
          terminalSessionId: targetPanel.terminalSessionId ?? null,
        },
        [targetPanelId]: {
          ...targetPanel,
          sessionId: sourcePanel.sessionId,
          terminalId: sourcePanel.terminalId ?? null,
          terminalSessionId: sourcePanel.terminalSessionId ?? null,
        },
      };
      const nextTabData: TabPanelData = {
        ...tabData,
        panels: nextPanels,
        activePanelId: targetPanelId,
      };

      set({
        tabPanels: {
          ...state.tabPanels,
          [state.activeTabId]: nextTabData,
        },
      });

      assertInvariants(nextTabData);
      useSessionStore.getState().setActiveSession(nextPanels[targetPanelId]?.sessionId ?? null);
      return targetPanelId;
    }

    if (Object.keys(tabData.panels).length <= 1) return null;

    const withoutSource = removePanelFromTree(tabData.layout, sourcePanelId);
    if (!withoutSource || !containsLeaf(withoutSource, targetPanelId)) return null;

    const movedLeaf: PanelNode = { type: 'leaf', panelId: sourcePanelId };
    const targetLeaf: PanelNode = { type: 'leaf', panelId: targetPanelId };
    const nextLayout = replaceLeafWithExistingLeaf(
      withoutSource,
      sourcePanelId,
      targetPanelId,
    );
    const splitNode = buildSplitNode(targetLeaf, movedLeaf, edge);
    const finalLayout = replaceLeafInTree(nextLayout, sourcePanelId, splitNode);

    const nextTabData: TabPanelData = {
      ...tabData,
      layout: finalLayout,
      activePanelId: sourcePanelId,
    };

    set({
      tabPanels: {
        ...state.tabPanels,
        [state.activeTabId]: nextTabData,
      },
    });

    assertInvariants(nextTabData);
    useSessionStore.getState().setActiveSession(sourcePanel.sessionId);
    return sourcePanelId;
  },

  graftTabIntoActiveTab: (sourceTabId, targetPanelId, edge) => {
    const state = get();
    const targetTabId = state.activeTabId;
    if (!targetTabId || sourceTabId === targetTabId) return null;

    const sourceTabData = state.tabPanels[sourceTabId];
    const targetTabData = state.tabPanels[targetTabId];
    if (!sourceTabData || !targetTabData) return null;
    if (!targetTabData.panels[targetPanelId]) return null;
    if (!containsLeaf(targetTabData.layout, targetPanelId)) return null;

    const clonedSource = cloneTabPanelTree(sourceTabData);
    if (!clonedSource) return null;

    const targetPanel = targetTabData.panels[targetPanelId];
    const shouldReplaceTarget = edge === 'center';
    if (edge === 'center' && targetPanel.sessionId !== null) return null;

    const replacement = shouldReplaceTarget
      ? clonedSource.layout
      : buildSplitNode({ type: 'leaf', panelId: targetPanelId }, clonedSource.layout, edge);

    const nextLayout = replaceLeafInTree(targetTabData.layout, targetPanelId, replacement);
    const nextTargetPanels = { ...targetTabData.panels };
    if (shouldReplaceTarget) {
      delete nextTargetPanels[targetPanelId];
    }

    const nextTabData: TabPanelData = {
      panels: { ...nextTargetPanels, ...clonedSource.panels },
      layout: nextLayout,
      activePanelId: clonedSource.activePanelId,
    };

    set({
      tabPanels: {
        ...state.tabPanels,
        [targetTabId]: nextTabData,
      },
    });

    assertInvariants(nextTabData);

    useSessionStore.getState().setActiveSession(
      nextTabData.panels[nextTabData.activePanelId]?.sessionId ?? null,
    );

    return clonedSource.activePanelId;
  },

  closePanel: (panelId) => {
    const state = get();
    const tabData = state.tabPanels[state.activeTabId];
    if (!tabData) return;

    // Guard: 마지막 패널 보호
    if (Object.keys(tabData.panels).length <= 1) return;

    const newLayout = removePanelFromTree(tabData.layout, panelId);
    if (!newLayout) return;

    const isClosingActive = tabData.activePanelId === panelId;
    const newActivePanelId = isClosingActive
      ? findFirstLeafId(newLayout)
      : tabData.activePanelId;

    const newPanels = { ...tabData.panels };
    delete newPanels[panelId];

    const newTabData: TabPanelData = {
      panels: newPanels,
      layout: newLayout,
      activePanelId: newActivePanelId,
    };

    // 단일 set() 호출
    set({
      tabPanels: {
        ...state.tabPanels,
        [state.activeTabId]: newTabData,
      },
    });

    assertInvariants(newTabData);

    // 활성 패널 닫기인 경우만 session-store 동기화
    if (isClosingActive) {
      const newSessionId = newPanels[newActivePanelId]?.sessionId ?? null;
      useSessionStore.getState().setActiveSession(newSessionId);
    }
  },

  setActivePanelId: (panelId) => {
    const state = get();
    const tabData = state.tabPanels[state.activeTabId];
    if (!tabData) return;
    if (!tabData.panels[panelId]) return;

    set({
      tabPanels: {
        ...state.tabPanels,
        [state.activeTabId]: {
          ...tabData,
          activePanelId: panelId,
        },
      },
    });

    const sessionId = tabData.panels[panelId].sessionId;
    useSessionStore.getState().setActiveSession(sessionId);
  },

  assignSession: (panelId, sessionId) => {
    get().assignSessionInTab(get().activeTabId, panelId, sessionId);
  },

  assignSessionInTab: (tabId, panelId, sessionId) => {
    const state = get();
    const tabData = state.tabPanels[tabId];
    if (!tabData) return;
    if (!tabData.panels[panelId]) return;

    // Guard: 중복 sessionId 방지 (null은 중복 허용)
    if (sessionId !== null) {
      // Cross-tab check: tabPanels 전체를 직접 순회 (순환 의존성 제거)
      for (const [candidateTabId, td] of Object.entries(state.tabPanels)) {
        const duplicate = Object.values(td.panels).find(
          p => p.sessionId === sessionId && !(candidateTabId === tabId && p.id === panelId)
        );
        if (duplicate) {
          if (process.env.NODE_ENV === 'development') {
            console.warn('[panel-store] assignSessionInTab() no-op: session already open in tab', candidateTabId, 'panel', duplicate.id);
          }
          return;
        }
      }
    }

    const nextPanels = {
      ...tabData.panels,
      [panelId]: { ...tabData.panels[panelId], sessionId, terminalId: null, terminalSessionId: null },
    };
    const fallbackActivePanelId =
      sessionId === null && panelId === tabData.activePanelId
        ? Object.values(nextPanels).find((panel) => panel.id !== panelId && panel.sessionId !== null)?.id
        : undefined;
    const nextActivePanelId = fallbackActivePanelId ?? tabData.activePanelId;
    const nextTabData: TabPanelData = {
      ...tabData,
      panels: nextPanels,
      activePanelId: nextActivePanelId,
    };

    set({
      tabPanels: {
        ...state.tabPanels,
        [tabId]: nextTabData,
      },
    });

    // 활성 패널인 경우만 session-store 동기화
    if (tabId === state.activeTabId && panelId === tabData.activePanelId) {
      useSessionStore.getState().setActiveSession(nextPanels[nextActivePanelId]?.sessionId ?? null);
    }
  },

  assignTerminal: (panelId, terminalId, terminalSessionId = null) => {
    const state = get();
    const tabData = state.tabPanels[state.activeTabId];
    if (!tabData) return;
    const panel = tabData.panels[panelId];
    if (!panel) return;

    const nextPanels = {
      ...tabData.panels,
      [panelId]: { ...panel, sessionId: null, terminalId, terminalSessionId },
    };
    const nextTabData: TabPanelData = {
      ...tabData,
      panels: nextPanels,
      activePanelId: panelId,
    };

    set({
      tabPanels: {
        ...state.tabPanels,
        [state.activeTabId]: nextTabData,
      },
    });

    useSessionStore.getState().setActiveSession(null);
  },

  resizeSplit: (leftAnchor, rightAnchor, ratio) => {
    const state = get();
    const tabData = state.tabPanels[state.activeTabId];
    if (!tabData) return;

    const clampedRatio = Math.max(0.15, Math.min(0.85, ratio));
    const newLayout = updateRatioInTree(tabData.layout, leftAnchor, rightAnchor, clampedRatio);

    set({
      tabPanels: {
        ...state.tabPanels,
        [state.activeTabId]: {
          ...tabData,
          layout: newLayout,
        },
      },
    });
  },

  persistLayout: () => {
    // No-op: persistence is now handled by tab-store
  },

  restoreLayout: () => {
    // No-op: restoration is now handled by tab-store
  },
}));
