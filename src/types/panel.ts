// Panel 인스턴스 타입
export interface Panel {
  readonly id: string;
  sessionId: string | null;
  terminalId?: string | null;
  terminalSessionId?: string | null;
}

// 레이아웃 트리 노드 유니온
export type PanelNode = LeafPanelNode | HSplitPanelNode | VSplitPanelNode;

export type PanelDropEdge = 'left' | 'right' | 'top' | 'bottom' | 'center';

export interface LeafPanelNode {
  type: 'leaf';
  panelId: string;
}

export interface HSplitPanelNode {
  type: 'hsplit';
  children: [PanelNode, PanelNode];
  ratio: number;
}

export interface VSplitPanelNode {
  type: 'vsplit';
  children: [PanelNode, PanelNode];
  ratio: number;
}

// 탭별 패널 데이터 (신규 — PanelStoreState 위에 추가)
export interface TabPanelData {
  layout: PanelNode;
  panels: Record<string, Panel>;
  activePanelId: string;
}

// panel-store 상태 인터페이스 (변경 — 기존 PanelStoreState 대체)
export interface PanelStoreState {
  /** 탭별 패널 데이터. 키 = tabId */
  tabPanels: Record<string, TabPanelData>;
  /** 현재 활성 탭 ID. tab-store.activeTabId와 동기화됨 */
  activeTabId: string;
}

// panel-store 액션 인터페이스
export interface PanelStoreActions {
  // 기존 액션 (시그니처 동일)
  splitPanel(panelId: string, direction: 'horizontal' | 'vertical', newSessionId?: string | null, position?: 'before' | 'after'): string | null;
  createTerminalPanel(panelId: string, terminalId: string, direction?: 'horizontal' | 'vertical'): string | null;
  movePanelNode(sourcePanelId: string, targetPanelId: string, edge: PanelDropEdge): string | null;
  graftTabIntoActiveTab(sourceTabId: string, targetPanelId: string, edge: PanelDropEdge): string | null;
  closePanel(panelId: string): void;
  assignSession(panelId: string, sessionId: string | null): void;
  assignSessionInTab(tabId: string, panelId: string, sessionId: string | null): void;
  assignTerminal(panelId: string, terminalId: string | null, terminalSessionId?: string | null): void;
  setActivePanelId(panelId: string): void;
  resizeSplit(leftAnchor: string, rightAnchor: string, ratio: number): void;
  initializeWithSession(sessionId: string | null): void;
  persistLayout(): void;
  restoreLayout(): void;

  // 신규: 탭 관리 액션
  /** 새 탭의 패널 데이터를 등록 */
  initTab(tabId: string, data: TabPanelData): void;
  /** 탭의 패널 데이터를 제거 */
  removeTab(tabId: string): void;
  /** 활성 탭 전환 (데이터 교체 없음, 포인터만 변경) */
  setActiveTabId(tabId: string): void;
  /** 특정 탭의 패널 데이터를 반환 */
  getTabPanelData(tabId: string): TabPanelData | undefined;

  // loadTabSnapshot 제거됨 — 더 이상 필요 없음
}

// 결합 타입
export type PanelStore = PanelStoreState & PanelStoreActions;

// localStorage 직렬화 DTO (Unit 4에서 완전 활용)
export interface PersistedPanelLayout {
  version: 1;
  layout: PanelNode;
  panels: Record<string, Panel>;
  activePanelId: string;
}

// localStorage 키 상수
export const PANEL_LAYOUT_STORAGE_KEY = 'tessera-panel-layout' as const;

// 세션 드래그 MIME 타입 (session-item.tsx → panel-wrapper.tsx 간 공유)
export const SESSION_DRAG_MIME = 'application/x-session-drag' as const;

// 워크스페이스 파일 드래그 MIME 타입 (composer 파일 참조 삽입용)
export const WORKSPACE_FILE_DRAG_MIME = 'application/x-workspace-file-drag' as const;

// 패널 헤더 드래그 MIME 타입 (개별 패널 세션 이동/새 탭 생성용)
export const PANEL_SESSION_DRAG_MIME = 'application/x-panel-session-drag' as const;

// 패널 leaf 자체 드래그 MIME 타입 (빈 패널 포함 레이아웃 재배치용)
export const PANEL_NODE_DRAG_MIME = 'application/x-panel-node-drag' as const;

// 탭 드래그 MIME 타입 (탭 리오더 + 세션 드롭 구분용)
export const TAB_DRAG_MIME = 'application/x-tab-drag' as const;

// 멀티패널 탭 드래그 MIME 타입 (탭 layout tree를 다른 탭 패널로 graft)
export const TAB_PANEL_TREE_DND_MIME = 'application/x-tab-panel-tree-drag' as const;
