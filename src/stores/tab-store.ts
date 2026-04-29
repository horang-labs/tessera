import { create } from 'zustand';
import { v4 as uuidv4 } from 'uuid';
import type {
  Tab,
  TabSnapshot,
  TabStore,
  TabStoreState,
  ProjectTabState,
  PersistedTab,
  PersistedTabStoreV1,
  PersistedTabStoreV2,
  PersistedTabStoreV3,
} from '@/types/tab';
import { TAB_STORE_KEY, LRU_LIMIT } from '@/types/tab';
import { PANEL_LAYOUT_STORAGE_KEY } from '@/types/panel';
import type { PersistedPanelLayout, PanelNode, TabPanelData } from '@/types/panel';
import { usePanelStore } from '@/stores/panel-store';
import { useSessionStore } from '@/stores/session-store';
import { ALL_PROJECTS_SENTINEL } from '@/lib/constants/project-strip';
import { getSpecialSessionSourceSessionId, isSpecialSession } from '@/lib/constants/special-sessions';
import { parseWorkspaceFileSessionId } from '@/lib/workspace-tabs/special-session';

// --- 순수 함수 헬퍼 ---

/** 레이아웃 트리에서 첫 번째 리프 노드의 panelId를 찾음 */
function findFirstLeafId(node: PanelNode): string {
  if (node.type === 'leaf') return node.panelId;
  return findFirstLeafId(node.children[0]);
}

/** LRU 목록에 새 ID를 프론트에 추가하고 LRU_LIMIT를 초과하면 잘라냄 (BR-002, BR-003) */
function computeNewLru(currentLru: string[], promotedId: string): string[] {
  return [promotedId, ...currentLru.filter(id => id !== promotedId)].slice(0, LRU_LIMIT);
}

/** 빈 TabSnapshot을 생성 (persistence DTO fallback용으로 유지) */
function createEmptySnapshot(panelId: string): TabSnapshot {
  return {
    layout: { type: 'leaf' as const, panelId },
    panels: { [panelId]: { id: panelId, sessionId: null } },
    activePanelId: panelId,
  };
}

function isAllProjectsScope(projectDir: string | null): boolean {
  return projectDir === ALL_PROJECTS_SENTINEL;
}

function getTabActiveSessionId(
  tabId: string,
  panelStore: ReturnType<typeof usePanelStore.getState>,
): string | null {
  const tabData = panelStore.tabPanels[tabId];
  return tabData?.panels[tabData.activePanelId]?.sessionId ?? null;
}

function isWorkspaceFilePreviewTab(
  tab: Tab,
  panelStore: ReturnType<typeof usePanelStore.getState>,
): boolean {
  if (!tab.isPreview) return false;
  const sessionId = getTabActiveSessionId(tab.id, panelStore);
  return sessionId ? parseWorkspaceFileSessionId(sessionId) !== null : false;
}

function isWorkspaceFileTab(
  tabId: string,
  panelStore: ReturnType<typeof usePanelStore.getState>,
): boolean {
  const sessionId = getTabActiveSessionId(tabId, panelStore);
  return sessionId ? parseWorkspaceFileSessionId(sessionId) !== null : false;
}

function insertTabAfter(tabs: Tab[], newTab: Tab, anchorTabId?: string | null): Tab[] {
  const anchorIndex = anchorTabId ? tabs.findIndex((tab) => tab.id === anchorTabId) : -1;
  if (anchorIndex === -1) return [...tabs, newTab];

  const nextTabs = [...tabs];
  nextTabs.splice(anchorIndex + 1, 0, newTab);
  return nextTabs;
}

/** 빈 탭 + 패널 데이터를 한 번에 생성 */
function createEmptyTab(projectDir: string | null = null): { tab: Tab; panelData: TabPanelData } {
  const panelId = uuidv4();
  const panelData: TabPanelData = {
    layout: { type: 'leaf' as const, panelId },
    panels: { [panelId]: { id: panelId, sessionId: null } },
    activePanelId: panelId,
  };
  return {
    tab: { id: uuidv4(), projectDir, title: null, isPreview: false },
    panelData,
  };
}

/** PersistedTab → Tab 변환 (snapshot 필드를 제외하고 런타임 Tab만 반환) */
function toRuntimeTab(t: PersistedTab, fallbackProjectDir: string | null): Tab {
  return {
    id: t.id,
    projectDir: inferPersistedTabProjectDir(t, fallbackProjectDir),
    title: t.title,
    isPreview: t.isPreview ?? false,
  };
}

function inferPersistedTabProjectDir(t: PersistedTab, fallbackProjectDir: string | null): string | null {
  if ('projectDir' in t) return t.projectDir ?? null;
  const activeSessionId = t.snapshot?.panels?.[t.snapshot.activePanelId]?.sessionId ?? null;
  const sourceSessionId = activeSessionId ? getSpecialSessionSourceSessionId(activeSessionId) : null;
  if (sourceSessionId) {
    return useSessionStore.getState().getSession(sourceSessionId)?.projectDir ?? fallbackProjectDir;
  }
  if (activeSessionId && isSpecialSession(activeSessionId)) return null;
  return fallbackProjectDir;
}

function inferTabProjectDir(initialSessionId: string | null | undefined, currentProjectDir: string | null): string | null {
  const sourceSessionId = initialSessionId ? getSpecialSessionSourceSessionId(initialSessionId) : null;
  if (sourceSessionId) {
    return useSessionStore.getState().getSession(sourceSessionId)?.projectDir ?? null;
  }
  if (initialSessionId && isSpecialSession(initialSessionId)) return null;

  if (initialSessionId) {
    const session = useSessionStore.getState().getSession(initialSessionId);
    if (session?.projectDir) return session.projectDir;
  }

  if (currentProjectDir && !isAllProjectsScope(currentProjectDir)) return currentProjectDir;
  return null;
}

function normalizeLruForTabs(lruTabIds: string[] | undefined, tabs: Tab[], activeTabId: string): string[] {
  const tabIds = new Set(tabs.map((tab) => tab.id));
  const normalized = [
    activeTabId,
    ...(lruTabIds ?? []),
  ].filter((id, index, list) => tabIds.has(id) && list.indexOf(id) === index);
  return normalized.slice(0, LRU_LIMIT);
}

function getStateTabs(projectState: ProjectTabState | null | undefined): Tab[] {
  return projectState?.tabs ?? [];
}

function getVisibleTabs(
  projectStates: Record<string, ProjectTabState>,
  globalState: ProjectTabState | null,
  projectDir: string | null,
): Tab[] {
  const globalTabs = getStateTabs(globalState);
  if (isAllProjectsScope(projectDir)) {
    return [
      ...globalTabs,
      ...Object.values(projectStates).flatMap((projectState) => projectState.tabs),
    ];
  }
  return [
    ...globalTabs,
    ...(projectDir ? getStateTabs(projectStates[projectDir]) : []),
  ];
}

function chooseActiveTabId(
  tabs: Tab[],
  preferredActiveTabId: string | null | undefined,
  projectState: ProjectTabState | null | undefined,
  globalState: ProjectTabState | null | undefined,
): string {
  if (preferredActiveTabId && tabs.some((tab) => tab.id === preferredActiveTabId)) {
    return preferredActiveTabId;
  }
  if (projectState?.activeTabId && tabs.some((tab) => tab.id === projectState.activeTabId)) {
    return projectState.activeTabId;
  }
  if (globalState?.activeTabId && tabs.some((tab) => tab.id === globalState.activeTabId)) {
    return globalState.activeTabId;
  }
  return tabs[0].id;
}

function buildStateFromTabs(
  tabs: Tab[],
  panelStore: ReturnType<typeof usePanelStore.getState>,
  preferredActiveTabId?: string,
): ProjectTabState | null {
  if (tabs.length === 0) return null;

  const tabPanelSnapshots: Record<string, TabPanelData> = {};
  for (const tab of tabs) {
    const data = panelStore.tabPanels[tab.id];
    if (data) tabPanelSnapshots[tab.id] = data;
  }

  const activeTabId =
    preferredActiveTabId && tabs.some((tab) => tab.id === preferredActiveTabId)
      ? preferredActiveTabId
      : tabs[0].id;

  return {
    tabs,
    activeTabId,
    lruTabIds: normalizeLruForTabs([activeTabId], tabs, activeTabId),
    tabPanelSnapshots,
  };
}

function saveVisibleTabsToScopedStates(
  state: TabStoreState,
  panelStore: ReturnType<typeof usePanelStore.getState>,
): {
  projectTabStates: Record<string, ProjectTabState>;
  globalTabState: ProjectTabState | null;
} {
  const projectTabs = new Map<string, Tab[]>();
  const globalTabs: Tab[] = [];

  for (const tab of state.tabs) {
    if (tab.projectDir === null) {
      globalTabs.push(tab);
      continue;
    }
    const existing = projectTabs.get(tab.projectDir) ?? [];
    existing.push(tab);
    projectTabs.set(tab.projectDir, existing);
  }

  const projectTabStates = isAllProjectsScope(state.currentProjectDir)
    ? {}
    : { ...state.projectTabStates };
  if (state.currentProjectDir && !isAllProjectsScope(state.currentProjectDir)) {
    delete projectTabStates[state.currentProjectDir];
  }
  for (const [projectDir, tabs] of projectTabs) {
    const activeTabId = state.activeTabId && tabs.some((tab) => tab.id === state.activeTabId)
      ? state.activeTabId
      : state.projectTabStates[projectDir]?.activeTabId;
    const nextState = buildStateFromTabs(tabs, panelStore, activeTabId);
    if (nextState) projectTabStates[projectDir] = nextState;
  }

  const globalActiveTabId = state.activeTabId && globalTabs.some((tab) => tab.id === state.activeTabId)
    ? state.activeTabId
    : state.globalTabState?.activeTabId;
  const globalTabState = buildStateFromTabs(globalTabs, panelStore, globalActiveTabId);

  return {
    projectTabStates,
    globalTabState,
  };
}

function toPersistedTab(tab: Tab, snapshot: TabPanelData | undefined): PersistedTab {
  return {
    id: tab.id,
    projectDir: tab.projectDir,
    snapshot: snapshot ?? createEmptySnapshot(uuidv4()),
    title: tab.title,
    isPreview: tab.isPreview,
  };
}

// --- 개발 환경 불변 조건 검증 ---

function assertTabStoreInvariants(state: TabStoreState): void {
  if (process.env.NODE_ENV !== 'development') return;

  const tabIds = new Set(state.tabs.map(t => t.id));

  // INV-STATE-01: tabs.length >= 1
  if (state.tabs.length < 1) {
    console.error('[tab-store] INVARIANT VIOLATION INV-STATE-01: tabs is empty');
  }

  // INV-STATE-02: activeTabId는 tabs에 존재
  if (!tabIds.has(state.activeTabId)) {
    console.error('[tab-store] INVARIANT VIOLATION INV-STATE-02: activeTabId not in tabs', {
      activeTabId: state.activeTabId,
      tabIds: [...tabIds],
    });
  }

  // INV-STATE-03: lruTabIds의 모든 ID가 tabs에 존재
  const lruGhosts = state.lruTabIds.filter(id => !tabIds.has(id));
  if (lruGhosts.length > 0) {
    console.error('[tab-store] INVARIANT VIOLATION INV-STATE-03: ghost IDs in lruTabIds', { lruGhosts });
  }

  // INV-STATE-04: lruTabIds.length <= LRU_LIMIT
  if (state.lruTabIds.length > LRU_LIMIT) {
    console.error('[tab-store] INVARIANT VIOLATION INV-STATE-04: lruTabIds exceeds LRU_LIMIT', {
      length: state.lruTabIds.length,
      LRU_LIMIT,
    });
  }

  // INV-STATE-05: activeTabId는 lruTabIds에 포함
  if (!state.lruTabIds.includes(state.activeTabId)) {
    console.error('[tab-store] INVARIANT VIOLATION INV-STATE-05: activeTabId not in lruTabIds', {
      activeTabId: state.activeTabId,
      lruTabIds: state.lruTabIds,
    });
  }

  // INV-STATE-06: tabs에 중복 ID 없음
  if (tabIds.size !== state.tabs.length) {
    console.error('[tab-store] INVARIANT VIOLATION INV-STATE-06: duplicate IDs in tabs', {
      tabCount: state.tabs.length,
      uniqueCount: tabIds.size,
    });
  }

  // INV-STATE-07: lruTabIds에 중복 ID 없음
  const lruSet = new Set(state.lruTabIds);
  if (lruSet.size !== state.lruTabIds.length) {
    console.error('[tab-store] INVARIANT VIOLATION INV-STATE-07: duplicate IDs in lruTabIds', {
      lruTabIds: state.lruTabIds,
    });
  }
}

// --- 초기 상태 ---

const initialPanelId = uuidv4();
const initialTabId = uuidv4();

// --- 스토어 생성 ---

export const useTabStore = create<TabStore>()((set, get) => ({
  // 초기 상태
  tabs: [{
    id: initialTabId,
    projectDir: null,
    title: null,
    isPreview: false,
  }],
  activeTabId: initialTabId,
  lruTabIds: [initialTabId],
  projectTabStates: {},
  globalTabState: null,
  currentProjectDir: null,

  // --- 액션 ---

  createTab: (initialSessionId?: string | null, options?: { insertAfterTabId?: string | null }): string => {
    const state = get();

    // Step 1: ID 생성
    const newTabId = uuidv4();
    const newPanelId = uuidv4();
    const projectDir = inferTabProjectDir(initialSessionId, state.currentProjectDir);

    // Step 2: 초기 패널 데이터 구성 (BR-009)
    const panelData: TabPanelData = {
      layout: { type: 'leaf' as const, panelId: newPanelId },
      panels: {
        [newPanelId]: { id: newPanelId, sessionId: initialSessionId ?? null },
      },
      activePanelId: newPanelId,
    };

    // Step 3: Tab 엔티티 구성 (BR-018: title은 항상 null)
    const newTab: Tab = {
      id: newTabId,
      projectDir,
      title: null,
      isPreview: false,
    };

    // Step 4: 상태 업데이트 (단일 set() 호출) — write-back 불필요
    const newLruIds = computeNewLru(state.lruTabIds, newTabId);
    set({
      tabs: insertTabAfter(state.tabs, newTab, options?.insertAfterTabId),
      activeTabId: newTabId,
      lruTabIds: newLruIds,
    });

    assertTabStoreInvariants(get());

    // Step 5: panel-store에 새 탭 등록 및 활성화
    const panelStore = usePanelStore.getState();
    panelStore.initTab(newTabId, panelData);
    panelStore.setActiveTabId(newTabId);

    return newTabId;
  },

  closeTab: (tabId: string): void => {
    const state = get();

    // Step 1: 유효성 검증
    const closingIdx = state.tabs.findIndex(t => t.id === tabId);
    if (closingIdx === -1) return; // no-op

    // Step 2: 마지막 탭 처리 (BR-001)
    if (state.tabs.length === 1) {
      // 새 빈 탭 생성 (이 호출이 activeTabId와 panel-store를 업데이트함)
      get().createTab();

      // 원래 탭을 제거 (createTab 후 state 다시 읽기)
      const afterCreate = get();
      const newTabs = afterCreate.tabs.filter(t => t.id !== tabId);
      const newLruIds = afterCreate.lruTabIds.filter(id => id !== tabId);
      set({ tabs: newTabs, lruTabIds: newLruIds });

      // panel-store에서 닫힌 탭 제거
      usePanelStore.getState().removeTab(tabId);

      assertTabStoreInvariants(get());
      return;
    }

    // Step 3: 활성 탭을 닫는 경우, 다음 활성 탭 결정
    if (tabId === state.activeTabId) {
      const rightNeighbor = state.tabs[closingIdx + 1];
      const leftNeighbor = state.tabs[closingIdx - 1];
      const isClosingWorkspaceFile = isWorkspaceFileTab(tabId, usePanelStore.getState());
      const nextTab = isClosingWorkspaceFile
        ? leftNeighbor ?? rightNeighbor
        : rightNeighbor ?? leftNeighbor;

      // setActiveTab이 내부적으로 panel-store.setActiveTabId를 호출
      get().setActiveTab(nextTab.id);
    }

    // Step 4: 닫는 탭을 tabs와 lruTabIds에서 제거 (단일 set())
    const currentState = get();
    set({
      tabs: currentState.tabs.filter(t => t.id !== tabId),
      lruTabIds: currentState.lruTabIds.filter(id => id !== tabId),
    });

    // Step 5: panel-store에서 닫힌 탭 제거
    usePanelStore.getState().removeTab(tabId);

    assertTabStoreInvariants(get());
  },

  closeOtherTabs: (tabId: string): void => {
    const state = get();
    const keepIdx = state.tabs.findIndex(t => t.id === tabId);
    if (keepIdx === -1) return;

    // 제거 대상 탭 ID 수집
    const removedTabIds = state.tabs.filter(t => t.id !== tabId).map(t => t.id);

    // 유지할 탭이 활성 탭이 아니면 먼저 활성화
    if (tabId !== state.activeTabId) {
      get().setActiveTab(tabId);
    }

    // 유지할 탭을 제외한 나머지 제거
    const afterActivate = get();
    set({
      tabs: afterActivate.tabs.filter(t => t.id === tabId),
      lruTabIds: afterActivate.lruTabIds.filter(id => id === tabId),
    });

    // panel-store에서 제거된 탭 정리
    const panelStore = usePanelStore.getState();
    for (const removedId of removedTabIds) {
      panelStore.removeTab(removedId);
    }

    assertTabStoreInvariants(get());
  },

  closeTabsToLeft: (tabId: string): void => {
    const state = get();
    const pivotIdx = state.tabs.findIndex(t => t.id === tabId);
    if (pivotIdx === -1) return;

    // 왼쪽에 탭이 없으면 no-op
    if (pivotIdx <= 0) return;

    const tabsToRemove = state.tabs.slice(0, pivotIdx).map(t => t.id);
    const removeSet = new Set(tabsToRemove);

    // 활성 탭이 제거 대상이면 pivot 탭을 활성화
    if (removeSet.has(state.activeTabId)) {
      get().setActiveTab(tabId);
    }

    const afterActivate = get();
    set({
      tabs: afterActivate.tabs.filter(t => !removeSet.has(t.id)),
      lruTabIds: afterActivate.lruTabIds.filter(id => !removeSet.has(id)),
    });

    // panel-store에서 제거된 탭 정리
    const panelStore = usePanelStore.getState();
    for (const removedId of tabsToRemove) {
      panelStore.removeTab(removedId);
    }

    assertTabStoreInvariants(get());
  },

  closeTabsToRight: (tabId: string): void => {
    const state = get();
    const pivotIdx = state.tabs.findIndex(t => t.id === tabId);
    if (pivotIdx === -1) return;

    // 오른쪽에 탭이 없으면 no-op
    if (pivotIdx >= state.tabs.length - 1) return;

    const tabsToRemove = state.tabs.slice(pivotIdx + 1).map(t => t.id);
    const removeSet = new Set(tabsToRemove);

    // 활성 탭이 제거 대상이면 pivot 탭을 활성화
    if (removeSet.has(state.activeTabId)) {
      get().setActiveTab(tabId);
    }

    const afterActivate = get();
    set({
      tabs: afterActivate.tabs.filter(t => !removeSet.has(t.id)),
      lruTabIds: afterActivate.lruTabIds.filter(id => !removeSet.has(id)),
    });

    // panel-store에서 제거된 탭 정리
    const panelStore = usePanelStore.getState();
    for (const removedId of tabsToRemove) {
      panelStore.removeTab(removedId);
    }

    assertTabStoreInvariants(get());
  },

  closeAllTabs: (): void => {
    // 새 빈 탭을 생성하고 기존 탭 모두 제거
    const state = get();
    const oldTabIds = new Set(state.tabs.map(t => t.id));

    get().createTab();

    const afterCreate = get();
    set({
      tabs: afterCreate.tabs.filter(t => !oldTabIds.has(t.id)),
      lruTabIds: afterCreate.lruTabIds.filter(id => !oldTabIds.has(id)),
    });

    // panel-store에서 제거된 탭 정리
    const panelStore = usePanelStore.getState();
    for (const oldId of oldTabIds) {
      panelStore.removeTab(oldId);
    }

    assertTabStoreInvariants(get());
  },

  setActiveTab: (tabId: string): void => {
    const state = get();

    // Step 1: 이미 활성 탭이면 no-op
    if (tabId === state.activeTabId) return;

    // Step 2: 탭이 존재해야 함
    const newTabIdx = state.tabs.findIndex(t => t.id === tabId);
    if (newTabIdx === -1) return; // no-op

    // Step 3: 새 LRU 목록 계산 (BR-002, BR-003)
    const newLruIds = computeNewLru(state.lruTabIds, tabId);

    // Step 4: tab-store 상태 업데이트 (단일 set()) — write-back 불필요
    set({
      activeTabId: tabId,
      lruTabIds: newLruIds,
    });

    assertTabStoreInvariants(get());

    // Step 5: panel-store에 활성 탭 전환 (포인터만 변경, 데이터 복사 불필요)
    usePanelStore.getState().setActiveTabId(tabId);
  },

  reorderTab: (dragTabId: string, dropTabId: string): void => {
    const state = get();

    // Step 1: 인덱스 찾기
    const dragIdx = state.tabs.findIndex(t => t.id === dragTabId);
    const dropIdx = state.tabs.findIndex(t => t.id === dropTabId);

    // Step 2: Guard
    if (dragIdx === -1 || dropIdx === -1) return;
    if (dragIdx === dropIdx) return;

    // Step 3: 새 순서 계산 (BR-014)
    const newTabs = [...state.tabs];
    const [draggedTab] = newTabs.splice(dragIdx, 1);

    // splice 후 dropIdx가 이동할 수 있음 (dragIdx < dropIdx인 경우 -1)
    const adjustedDropIdx = dragIdx < dropIdx ? dropIdx - 1 : dropIdx;
    newTabs.splice(adjustedDropIdx, 0, draggedTab);

    // Step 4: 상태 업데이트 (activeTabId, lruTabIds, panel-store 변경 없음 — BR-014)
    set({ tabs: newTabs });
  },

  createTabWithSession: (sessionId: string): void => {
    // Ctrl+클릭 시나리오용 시맨틱 래퍼 (내부는 createTab)
    get().createTab(sessionId);
  },

  openPreview: (sessionId: string): void => {
    const state = get();
    const panelStore = usePanelStore.getState();

    // Step 1: 기존 채팅/세션 프리뷰 탭 검색. 파일 프리뷰 슬롯은 별도로 유지한다.
    let existingPreview = state.tabs.find(t => t.isPreview && !isWorkspaceFilePreviewTab(t, panelStore));

    // Step 1.5: 멀티패널 프리뷰 탭은 자동 pin → 새 프리뷰 탭 생성으로 진행
    // 멀티패널 탭은 의미 있는 레이아웃이므로 프리뷰로 재사용하면 안 됨
    if (existingPreview) {
      const previewLayout = panelStore.tabPanels[existingPreview.id]?.layout;

      if (previewLayout && previewLayout.type !== 'leaf') {
        get().pinTab(existingPreview.id);
        existingPreview = undefined;
      }
    }

    if (existingPreview) {
      // Step 2a: 프리뷰 탭이 이미 있으면 → 활성화 + 세션 교체
      // 먼저 해당 탭을 활성화
      if (existingPreview.id !== state.activeTabId) {
        get().setActiveTab(existingPreview.id);
      }
      // 활성 패널의 세션을 교체
      const tabData = panelStore.tabPanels[panelStore.activeTabId];
      if (tabData) {
        panelStore.assignSession(tabData.activePanelId, sessionId);
        set({ tabs: [...get().tabs] });
      }
    } else {
      // Step 2b: 프리뷰 탭이 없으면 → 새 프리뷰 탭 생성
      // 활성 패널이 비어있으면 현재 탭을 프리뷰로 재사용 (불필요한 탭 생성 방지)
      const tabData = panelStore.tabPanels[state.activeTabId];
      const activePanel = tabData?.panels[tabData?.activePanelId ?? ''];

      if (activePanel?.sessionId === null) {
        // 빈 패널: 세션 할당 + 현재 탭을 프리뷰로 변환
        panelStore.assignSession(tabData!.activePanelId, sessionId);
        set({
          tabs: get().tabs.map((tab): Tab =>
            tab.id === state.activeTabId ? { ...tab, isPreview: true } : tab,
          ),
        });
      } else {
        // 세션이 있는 패널: 새 탭 생성
        const newTabId = get().createTab(sessionId);
        // createTab이 isPreview: false로 생성하므로 true로 변경
        set({
          tabs: get().tabs.map((tab): Tab =>
            tab.id === newTabId ? { ...tab, isPreview: true } : tab,
          ),
        });
      }
    }
  },

  openWorkspaceFilePreview: (
    sessionId: string,
    options?: { insertAfterTabId?: string | null },
  ): void => {
    const state = get();
    const panelStore = usePanelStore.getState();

    // 파일 프리뷰 슬롯만 재사용한다. 채팅/세션 프리뷰 탭은 건드리지 않는다.
    let existingPreview = state.tabs.find(t => isWorkspaceFilePreviewTab(t, panelStore));

    if (existingPreview) {
      const previewLayout = panelStore.tabPanels[existingPreview.id]?.layout;
      if (previewLayout && previewLayout.type !== 'leaf') {
        get().pinTab(existingPreview.id);
        existingPreview = undefined;
      }
    }

    if (existingPreview) {
      if (existingPreview.id !== state.activeTabId) {
        get().setActiveTab(existingPreview.id);
      }
      const tabData = panelStore.tabPanels[panelStore.activeTabId];
      if (tabData) {
        panelStore.assignSession(tabData.activePanelId, sessionId);
        get().syncTabProjectFromSession(panelStore.activeTabId, sessionId);
        set({ tabs: [...get().tabs] });
      }
      return;
    }

    const tabData = panelStore.tabPanels[state.activeTabId];
    const activePanel = tabData?.panels[tabData?.activePanelId ?? ''];
    if (activePanel?.sessionId === null) {
      panelStore.assignSession(tabData!.activePanelId, sessionId);
      get().syncTabProjectFromSession(state.activeTabId, sessionId);
      set({
        tabs: get().tabs.map((tab): Tab =>
          tab.id === state.activeTabId ? { ...tab, isPreview: true } : tab,
        ),
      });
      return;
    }

    const newTabId = get().createTab(sessionId, {
      insertAfterTabId: options?.insertAfterTabId ?? state.activeTabId,
    });
    set({
      tabs: get().tabs.map((tab): Tab =>
        tab.id === newTabId ? { ...tab, isPreview: true } : tab,
      ),
    });
  },

  pinTab: (tabId: string): void => {
    const state = get();
    const target = state.tabs.find(t => t.id === tabId);
    if (!target || !target.isPreview) return; // no-op

    set({
      tabs: state.tabs.map((tab): Tab =>
        tab.id === tabId ? { ...tab, isPreview: false } : tab,
      ),
    });
  },

  syncTabProjectFromSession: (tabId: string, sessionId: string | null): void => {
    const state = get();
    const tab = state.tabs.find((item) => item.id === tabId);
    if (!tab) return;

    const projectDir = inferTabProjectDir(sessionId, state.currentProjectDir);
    if (tab.projectDir === projectDir) return;

    set({
      tabs: state.tabs.map((item): Tab =>
        item.id === tabId ? { ...item, projectDir } : item,
      ),
    });
  },

  findSessionLocation: (sessionId: string): { tabId: string; panelId: string } | null => {
    const state = get();
    const panelStore = usePanelStore.getState();

    // panel-store.tabPanels에서 모든 탭을 검색
    for (const tab of state.tabs) {
      const tabData = panelStore.tabPanels[tab.id];
      if (!tabData) continue;
      for (const [panelId, panel] of Object.entries(tabData.panels)) {
        if (panel.sessionId === sessionId) {
          return { tabId: tab.id, panelId };
        }
      }
    }

    return null;
  },

  getActiveTabSnapshot: (): TabSnapshot => {
    const state = get();
    const panelStore = usePanelStore.getState();
    const tabData = panelStore.tabPanels[state.activeTabId];
    if (tabData) {
      return {
        layout: tabData.layout,
        panels: tabData.panels,
        activePanelId: tabData.activePanelId,
      };
    }
    // fallback: 초기 상태에서 tabPanels가 비어있을 수 있음
    const fallbackPanelId = uuidv4();
    return createEmptySnapshot(fallbackPanelId);
  },

  persistToLocalStorage: (): void => {
    const state = get();

    // Guard: 프로젝트 미결정 상태에서는 persist하지 않음 (데이터 손실 방지)
    if (state.currentProjectDir === null) return;

    const panelStore = usePanelStore.getState();
    const scopedStates = saveVisibleTabsToScopedStates(state, panelStore);

    const projects: PersistedTabStoreV3['projects'] = {};
    for (const [dir, pState] of Object.entries(scopedStates.projectTabStates)) {
      projects[dir] = {
        tabs: pState.tabs.map((tab) => toPersistedTab(tab, pState.tabPanelSnapshots?.[tab.id])),
        activeTabId: pState.activeTabId,
      };
    }

    const global = scopedStates.globalTabState
      ? {
          tabs: scopedStates.globalTabState.tabs.map((tab) =>
            toPersistedTab(tab, scopedStates.globalTabState?.tabPanelSnapshots?.[tab.id])
          ),
          activeTabId: scopedStates.globalTabState.activeTabId,
        }
      : null;

    const data: PersistedTabStoreV3 = {
      version: 3,
      currentProjectDir: state.currentProjectDir,
      activeTabId: state.activeTabId,
      projects,
      global,
    };

    // Step 3: 직렬화 및 저장
    try {
      localStorage.setItem(TAB_STORE_KEY, JSON.stringify(data));
    } catch (e) {
      console.warn('[tab-store] persistToLocalStorage() failed:', e);
    }
  },

  restoreFromLocalStorage: (): void => {
    /** 빈 탭 하나로 초기화하는 헬퍼 (클로저로 set 접근) */
    const initializeEmpty = () => {
      const { tab, panelData } = createEmptyTab();
      set({
        tabs: [tab],
        activeTabId: tab.id,
        lruTabIds: [tab.id],
        projectTabStates: {},
        globalTabState: null,
        currentProjectDir: null,
      });
      const panelStore = usePanelStore.getState();
      panelStore.initTab(tab.id, panelData);
      panelStore.setActiveTabId(tab.id);
    };

    const applyRestoredScope = (
      projectTabStates: Record<string, ProjectTabState>,
      globalTabState: ProjectTabState | null,
      currentProjectDir: string | null,
      preferredActiveTabId: string | null,
    ) => {
      const panelStore = usePanelStore.getState();
      for (const oldTabId of Object.keys(panelStore.tabPanels)) {
        panelStore.removeTab(oldTabId);
      }

      let nextProjectTabStates = projectTabStates;
      let nextGlobalTabState = globalTabState;
      let visibleTabs = getVisibleTabs(nextProjectTabStates, nextGlobalTabState, currentProjectDir);

      if (visibleTabs.length === 0) {
        const projectDir =
          currentProjectDir && !isAllProjectsScope(currentProjectDir)
            ? currentProjectDir
            : null;
        const { tab, panelData } = createEmptyTab(projectDir);
        const createdState: ProjectTabState = {
          tabs: [tab],
          activeTabId: tab.id,
          lruTabIds: [tab.id],
          tabPanelSnapshots: { [tab.id]: panelData },
        };
        if (projectDir === null) {
          nextGlobalTabState = createdState;
        } else {
          nextProjectTabStates = {
            ...nextProjectTabStates,
            [projectDir]: createdState,
          };
        }
        visibleTabs = [tab];
      }

      const activeTabId = chooseActiveTabId(
        visibleTabs,
        preferredActiveTabId,
        currentProjectDir && !isAllProjectsScope(currentProjectDir)
          ? nextProjectTabStates[currentProjectDir]
          : undefined,
        nextGlobalTabState,
      );

      set({
        tabs: visibleTabs,
        activeTabId,
        lruTabIds: normalizeLruForTabs([activeTabId], visibleTabs, activeTabId),
        projectTabStates: nextProjectTabStates,
        globalTabState: nextGlobalTabState,
        currentProjectDir,
      });

      for (const tab of visibleTabs) {
        const snapshot = tab.projectDir === null
          ? nextGlobalTabState?.tabPanelSnapshots?.[tab.id]
          : nextProjectTabStates[tab.projectDir]?.tabPanelSnapshots?.[tab.id];
        if (snapshot) {
          panelStore.initTab(tab.id, snapshot);
        }
      }
      panelStore.setActiveTabId(activeTabId);
    };

    try {
      const raw = localStorage.getItem(TAB_STORE_KEY);

      if (raw === null) {
        // TAB_STORE_KEY가 없는 경우: 레거시 마이그레이션 또는 fresh init
        const legacyRaw = localStorage.getItem(PANEL_LAYOUT_STORAGE_KEY);
        if (legacyRaw !== null) {
          runLegacyMigration(legacyRaw, initializeEmpty, set);
        } else {
          initializeEmpty();
        }
        return;
      }

      const parsed = JSON.parse(raw) as { version?: number };

      // --- v3 복원 ---
      if (parsed.version === 3) {
        const v3 = parsed as PersistedTabStoreV3;
        if (!v3.projects || typeof v3.projects !== 'object') {
          console.warn('[tab-store] restoreFromLocalStorage() v3 projects invalid');
          initializeEmpty();
          return;
        }

        const projectTabStates: Record<string, ProjectTabState> = {};
        for (const [dir, pData] of Object.entries(v3.projects)) {
          if (!Array.isArray(pData.tabs) || pData.tabs.length === 0) continue;
          const tabs = pData.tabs.map((tab) => toRuntimeTab(tab, dir));
          let activeTabId = pData.activeTabId;
          if (!tabs.find((tab) => tab.id === activeTabId)) {
            activeTabId = tabs[0].id;
          }
          const tabPanelSnapshots: Record<string, TabPanelData> = {};
          for (const tab of pData.tabs) {
            if (tab.snapshot) tabPanelSnapshots[tab.id] = tab.snapshot;
          }
          projectTabStates[dir] = {
            tabs,
            activeTabId,
            lruTabIds: [activeTabId],
            tabPanelSnapshots,
          };
        }

        let globalTabState: ProjectTabState | null = null;
        if (v3.global && Array.isArray(v3.global.tabs) && v3.global.tabs.length > 0) {
          const tabs = v3.global.tabs.map((tab) => toRuntimeTab(tab, null));
          let activeTabId = v3.global.activeTabId;
          if (!tabs.find((tab) => tab.id === activeTabId)) {
            activeTabId = tabs[0].id;
          }
          const tabPanelSnapshots: Record<string, TabPanelData> = {};
          for (const tab of v3.global.tabs) {
            if (tab.snapshot) tabPanelSnapshots[tab.id] = tab.snapshot;
          }
          globalTabState = {
            tabs,
            activeTabId,
            lruTabIds: [activeTabId],
            tabPanelSnapshots,
          };
        }

        applyRestoredScope(projectTabStates, globalTabState, v3.currentProjectDir, v3.activeTabId);
        return;
      }

      // --- v2 복원 ---
      if (parsed.version === 2) {
        const v2 = parsed as PersistedTabStoreV2;
        if (!v2.projects || typeof v2.projects !== 'object') {
          console.warn('[tab-store] restoreFromLocalStorage() v2 projects invalid');
          initializeEmpty();
          return;
        }

        const projectTabStates: Record<string, ProjectTabState> = {};
        let globalTabState: ProjectTabState | null = null;
        for (const [dir, pData] of Object.entries(v2.projects)) {
          if (!Array.isArray(pData.tabs) || pData.tabs.length === 0) continue;
          const tabs = pData.tabs.map((tab) => toRuntimeTab(tab, dir));
          let activeTabId = pData.activeTabId;
          if (!tabs.find(t => t.id === activeTabId)) {
            activeTabId = tabs[0].id;
          }
          const tabPanelSnapshots: Record<string, TabPanelData> = {};
          for (const t of pData.tabs) {
            if (t.snapshot) {
              tabPanelSnapshots[t.id] = t.snapshot;
            }
          }
          const projectTabs = tabs.filter((tab) => tab.projectDir !== null);
          const globalTabs = tabs.filter((tab) => tab.projectDir === null);

          if (projectTabs.length > 0) {
            projectTabStates[dir] = {
              tabs: projectTabs,
              activeTabId: projectTabs.some((tab) => tab.id === activeTabId) ? activeTabId : projectTabs[0].id,
              lruTabIds: [projectTabs.some((tab) => tab.id === activeTabId) ? activeTabId : projectTabs[0].id],
              tabPanelSnapshots,
            };
          }
          if (globalTabs.length > 0) {
            const previousGlobalState = globalTabState as ProjectTabState | null;
            const existingGlobalTabs: Tab[] = previousGlobalState?.tabs ?? [];
            const nextGlobalTabs: Tab[] = [...existingGlobalTabs, ...globalTabs];
            const globalActiveTabId: string = globalTabs.some((tab) => tab.id === activeTabId)
              ? activeTabId
              : (previousGlobalState?.activeTabId ?? globalTabs[0].id);
            const previousSnapshots = previousGlobalState?.tabPanelSnapshots ?? {};
            globalTabState = {
              tabs: nextGlobalTabs,
              activeTabId: globalActiveTabId,
              lruTabIds: [globalActiveTabId],
              tabPanelSnapshots: {
                ...previousSnapshots,
                ...tabPanelSnapshots,
              },
            };
          }
        }

        applyRestoredScope(projectTabStates, globalTabState, v2.currentProjectDir, null);
        return;
      }

      // --- v1 복원 (레거시 마이그레이션) ---
      if (parsed.version === 1) {
        const v1 = parsed as PersistedTabStoreV1;
        if (!Array.isArray(v1.tabs) || v1.tabs.length === 0 || typeof v1.activeTabId !== 'string') {
          console.warn('[tab-store] restoreFromLocalStorage() v1 data invalid');
          initializeEmpty();
          return;
        }

        const restoredTabs = v1.tabs.map((tab) => toRuntimeTab(tab, null));
        let resolvedActiveTabId = v1.activeTabId;
        if (!restoredTabs.find(t => t.id === resolvedActiveTabId)) {
          resolvedActiveTabId = restoredTabs[0].id;
        }

        const tabPanelSnapshots: Record<string, TabPanelData> = {};
        for (const t of v1.tabs) {
          if (t.snapshot) {
            tabPanelSnapshots[t.id] = t.snapshot;
          }
        }

        applyRestoredScope(
          {},
          {
            tabs: restoredTabs,
            activeTabId: resolvedActiveTabId,
            lruTabIds: [resolvedActiveTabId],
            tabPanelSnapshots,
          },
          null,
          resolvedActiveTabId,
        );
        return;
      }

      // 알 수 없는 버전
      console.warn('[tab-store] restoreFromLocalStorage() unknown version:', parsed.version);
      initializeEmpty();
    } catch (e) {
      console.warn('[tab-store] restoreFromLocalStorage() failed:', e);
      initializeEmpty();
    }
  },

  switchProject: (projectDir: string): void => {
    const state = get();

    // No-op: 이미 같은 프로젝트
    if (projectDir === state.currentProjectDir) return;

    const panelStore = usePanelStore.getState();
    const scopedStates = state.currentProjectDir !== null
      ? saveVisibleTabsToScopedStates(state, panelStore)
      : {
          projectTabStates: state.projectTabStates,
          globalTabState: state.globalTabState,
        };

    let projectTabStates = scopedStates.projectTabStates;
    let globalTabState = scopedStates.globalTabState;
    let visibleTabs = getVisibleTabs(projectTabStates, globalTabState, projectDir);

    if (visibleTabs.length === 0) {
      const emptyProjectDir = isAllProjectsScope(projectDir) ? null : projectDir;
      const { tab, panelData } = createEmptyTab(emptyProjectDir);
      const emptyState: ProjectTabState = {
        tabs: [tab],
        activeTabId: tab.id,
        lruTabIds: [tab.id],
        tabPanelSnapshots: { [tab.id]: panelData },
      };
      if (emptyProjectDir === null) {
        globalTabState = emptyState;
      } else {
        projectTabStates = {
          ...projectTabStates,
          [emptyProjectDir]: emptyState,
        };
      }
      visibleTabs = [tab];
    }

    const targetProjectState = !isAllProjectsScope(projectDir)
      ? projectTabStates[projectDir]
      : undefined;
    const activeTabId = chooseActiveTabId(
      visibleTabs,
      state.activeTabId,
      targetProjectState,
      globalTabState,
    );

    set({
      tabs: visibleTabs,
      activeTabId,
      lruTabIds: normalizeLruForTabs([activeTabId], visibleTabs, activeTabId),
      projectTabStates,
      globalTabState,
      currentProjectDir: projectDir,
    });

    assertTabStoreInvariants(get());

    // panel-store 교체 — 이전 탭 데이터 제거, 현재 스코프에서 보이는 탭 데이터 등록
    for (const oldTabId of Object.keys(panelStore.tabPanels)) {
      panelStore.removeTab(oldTabId);
    }
    for (const tab of visibleTabs) {
      const data = tab.projectDir === null
        ? globalTabState?.tabPanelSnapshots?.[tab.id]
        : projectTabStates[tab.projectDir]?.tabPanelSnapshots?.[tab.id];
      if (data) panelStore.initTab(tab.id, data);
    }
    panelStore.setActiveTabId(activeTabId);
  },

  removeProjectTabs: (projectDir: string): void => {
    const state = get();
    const panelStore = usePanelStore.getState();
    const scopedStates = state.currentProjectDir !== null
      ? saveVisibleTabsToScopedStates(state, panelStore)
      : {
          projectTabStates: state.projectTabStates,
          globalTabState: state.globalTabState,
        };

    const { [projectDir]: _, ...restProjectStates } = scopedStates.projectTabStates;
    const currentProjectDir = state.currentProjectDir === projectDir ? null : state.currentProjectDir;

    let visibleTabs = getVisibleTabs(restProjectStates, scopedStates.globalTabState, currentProjectDir);
    let globalTabState = scopedStates.globalTabState;
    if (visibleTabs.length === 0) {
      const { tab, panelData } = createEmptyTab(null);
      globalTabState = {
        tabs: [tab],
        activeTabId: tab.id,
        lruTabIds: [tab.id],
        tabPanelSnapshots: { [tab.id]: panelData },
      };
      visibleTabs = [tab];
    }

    const activeTabId = chooseActiveTabId(
      visibleTabs,
      state.activeTabId,
      currentProjectDir && !isAllProjectsScope(currentProjectDir)
        ? restProjectStates[currentProjectDir]
        : undefined,
      globalTabState,
    );

    set({
      tabs: visibleTabs,
      activeTabId,
      lruTabIds: normalizeLruForTabs([activeTabId], visibleTabs, activeTabId),
      projectTabStates: restProjectStates,
      globalTabState,
      currentProjectDir,
    });

    for (const oldTabId of Object.keys(panelStore.tabPanels)) {
      panelStore.removeTab(oldTabId);
    }
    for (const tab of visibleTabs) {
      const data = tab.projectDir === null
        ? globalTabState?.tabPanelSnapshots?.[tab.id]
        : restProjectStates[tab.projectDir]?.tabPanelSnapshots?.[tab.id];
      if (data) panelStore.initTab(tab.id, data);
    }
    panelStore.setActiveTabId(activeTabId);
  },
}));

// --- 레거시 마이그레이션 헬퍼 (모듈 수준 함수) ---
// set은 useTabStore.setState와 동일한 타입을 사용

type TabStoreSet = (
  partial: Partial<TabStoreState> | ((state: TabStoreState) => Partial<TabStoreState>),
) => void;

function runLegacyMigration(
  legacyRaw: string,
  initializeEmpty: () => void,
  set: TabStoreSet,
): void {
  try {
    const legacyParsed = JSON.parse(legacyRaw) as PersistedPanelLayout;

    // 최소 필드 검증
    if (!legacyParsed.layout || !legacyParsed.panels) {
      console.warn('[tab-store] restoreFromLocalStorage() legacy data missing required fields, initializing empty');
      initializeEmpty();
      return;
    }

    // 레거시 데이터에서 TabSnapshot (= TabPanelData) 구성
    const legacySnapshot: TabSnapshot = {
      layout: legacyParsed.layout,
      panels: legacyParsed.panels,
      activePanelId: legacyParsed.activePanelId ?? findFirstLeafId(legacyParsed.layout),
    };

    // 마이그레이션된 탭 ID 생성
    const migratedTabId = uuidv4();
    const migratedTab: Tab = {
      id: migratedTabId,
      projectDir: null,
      title: null,
      isPreview: false,
    };

    // PersistedTabStoreV1 구성 및 새 키에 저장
    const migratedStore: PersistedTabStoreV1 = {
      version: 1,
      tabs: [{
        id: migratedTabId,
        projectDir: null,
        snapshot: legacySnapshot,
        title: null,
        isPreview: false,
      }],
      activeTabId: migratedTabId,
    };

    try {
      localStorage.setItem(TAB_STORE_KEY, JSON.stringify(migratedStore));
    } catch (e) {
      console.warn('[tab-store] Migration write to localStorage failed:', e);
    }
    // PANEL_LAYOUT_STORAGE_KEY는 삭제하지 않음 (BR-012: 마이그레이션 멱등성)

    // 런타임 상태 적용
    set({
      tabs: [migratedTab],
      activeTabId: migratedTabId,
      lruTabIds: [migratedTabId],
      projectTabStates: {},
      globalTabState: {
        tabs: [migratedTab],
        activeTabId: migratedTabId,
        lruTabIds: [migratedTabId],
        tabPanelSnapshots: { [migratedTabId]: legacySnapshot },
      },
      currentProjectDir: null,
    });

    // panel-store에 마이그레이션된 탭 등록
    const panelStore = usePanelStore.getState();
    panelStore.initTab(migratedTabId, legacySnapshot);
    panelStore.setActiveTabId(migratedTabId);
  } catch (e) {
    console.warn('[tab-store] Legacy migration failed:', e);
    initializeEmpty();
  }
}
