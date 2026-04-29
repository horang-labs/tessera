import type { Panel, PanelNode } from '@/types/panel';

// --- 상수 ---

/** localStorage 키 — 탭 스토어 직렬화 데이터 */
export const TAB_STORE_KEY = 'tessera-tab-store' as const;

/** LRU 마운트 윈도우 최대 크기. 이 수 이상의 PanelContainer는 DOM에 존재하지 않음. */
export const LRU_LIMIT = 5;

/** 탭 버튼 최소 너비(px) */
export const TAB_MIN_WIDTH = 160;

/** 탭 버튼 최대 너비(px) */
export const TAB_MAX_WIDTH = 280;

// --- 핵심 도메인 엔티티 ---

/**
 * 탭의 패널 상태 스냅샷. 탭 전환 시 panel-store와 tab-store 사이의 교환 단위.
 *
 * 불변 조건:
 * - INV-SNAP-01: Object.keys(panels) 수 === layout 트리의 리프 수
 * - INV-SNAP-02: panels[activePanelId] 가 존재해야 함
 * - INV-SNAP-03: Object.keys(panels).length >= 1
 * - INV-SNAP-04: snapshot 내 panel.sessionId 는 null이거나 고유해야 함
 */
export interface TabSnapshot {
  /** 패널 레이아웃 이진 트리의 루트 */
  layout: PanelNode;
  /** 모든 패널의 플랫 맵. 키 = panelId */
  panels: Record<string, Panel>;
  /** 이 탭에서 포커스를 가진 패널 ID */
  activePanelId: string;
}

/**
 * 런타임 탭 엔티티. 탭 바의 탭 하나를 나타냄.
 *
 * 불변 조건:
 * - INV-TAB-01: id는 생성 후 불변
 * - INV-TAB-02: MVP에서 title은 항상 null
 *
 * 주의: 패널 상태는 panel-store.tabPanels[tab.id]에서 읽어야 함.
 * snapshot 필드는 제거됨 — panel-store가 단일 진실 공급원(SSOT).
 */
export interface Tab {
  /** 탭의 고유 식별자. 생성 시 한 번 할당되고 변경되지 않음. */
  readonly id: string;
  /** 이 탭이 속한 프로젝트. null이면 모든 프로젝트에서 보이는 전역 탭. */
  projectDir: string | null;
  /** 수동 지정 탭 이름. MVP에서는 항상 null (P1 기능). */
  title: string | null;
  /** 프리뷰 탭 여부. 채팅 프리뷰와 파일 프리뷰는 서로 다른 슬롯으로 재사용됨. */
  isPreview: boolean;
}

/**
 * 프로젝트별 탭 상태 슬라이스.
 * projectTabStates의 value 타입이자 프로젝트 전환 시 save/restore 단위.
 */
export interface ProjectTabState {
  tabs: Tab[];
  activeTabId: string;
  lruTabIds: string[];
  /** panel-store의 탭별 패널 데이터 백업 (프로젝트 전환 시 저장) */
  tabPanelSnapshots?: Record<string, import('@/types/panel').TabPanelData>;
}

/**
 * tab-store의 런타임 상태.
 *
 * 불변 조건:
 * - INV-STATE-01: tabs.length >= 1
 * - INV-STATE-02: tabs에 activeTabId가 항상 존재
 * - INV-STATE-03: lruTabIds의 모든 ID가 tabs에 존재
 * - INV-STATE-04: lruTabIds.length <= LRU_LIMIT
 * - INV-STATE-05: lruTabIds에 activeTabId가 항상 포함
 * - INV-STATE-06: tabs에 중복 ID 없음
 * - INV-STATE-07: lruTabIds에 중복 ID 없음
 */
export interface TabStoreState {
  /** 시각적 순서대로 정렬된 탭 목록 (현재 활성 프로젝트의 탭) */
  tabs: Tab[];
  /** 현재 표시 중인 탭 ID */
  activeTabId: string;
  /** 최근 활성화 순 탭 ID 목록 (앞 = 최신). PanelContainer 마운트 여부 결정. */
  lruTabIds: string[];

  /** 프로젝트별 탭 상태 백업. 키 = projectDir (encodedDir). */
  projectTabStates: Record<string, ProjectTabState>;
  /** 모든 프로젝트에서 항상 보이는 전역 탭 상태. */
  globalTabState: ProjectTabState | null;
  /** 현재 활성 프로젝트 디렉토리. null이면 아직 프로젝트 미결정 상태. */
  currentProjectDir: string | null;
}

/**
 * tab-store의 액션 인터페이스
 */
export interface TabStoreActions {
  /**
   * 새 탭을 생성하고 활성화.
   * @param initialSessionId 초기 패널에 pre-assign할 세션 ID (선택)
   * @param options 탭 생성 옵션. insertAfterTabId가 있으면 해당 탭 바로 뒤에 삽입.
   * @returns 새 탭의 ID
   */
  createTab(initialSessionId?: string | null, options?: { insertAfterTabId?: string | null }): string;

  /**
   * 지정한 탭을 닫음.
   * 마지막 탭을 닫으면 빈 탭을 자동 생성 (BR-001).
   */
  closeTab(tabId: string): void;

  /**
   * 지정한 탭을 제외한 나머지 탭을 모두 닫음.
   */
  closeOtherTabs(tabId: string): void;

  /**
   * 지정한 탭의 왼쪽에 있는 탭을 모두 닫음.
   */
  closeTabsToLeft(tabId: string): void;

  /**
   * 지정한 탭의 오른쪽에 있는 탭을 모두 닫음.
   */
  closeTabsToRight(tabId: string): void;

  /**
   * 모든 탭을 닫고 빈 탭을 하나 생성.
   */
  closeAllTabs(): void;

  /**
   * 지정한 탭을 활성화.
   * 이미 활성 탭이면 no-op.
   */
  setActiveTab(tabId: string): void;

  /**
   * 탭을 드래그-앤-드롭으로 재정렬.
   * activeTabId, lruTabIds, 스냅샷은 변경하지 않음 (BR-014).
   */
  reorderTab(dragTabId: string, dropTabId: string): void;

  /**
   * 특정 세션을 새 탭에서 열기 (Ctrl+클릭 시나리오용 시맨틱 래퍼).
   * 내부적으로 createTab(sessionId)을 호출.
   */
  createTabWithSession(sessionId: string): void;

  /**
   * 프리뷰 탭에서 세션 열기. 기존 프리뷰 탭이 있으면 세션만 교체, 없으면 새 프리뷰 탭 생성.
   * 채팅/세션 프리뷰 슬롯만 재사용한다.
   */
  openPreview(sessionId: string): void;

  /**
   * 파일 프리뷰 탭에서 파일을 열기. 채팅/세션 프리뷰 탭과 별도의 프리뷰 슬롯을 재사용한다.
   */
  openWorkspaceFilePreview(sessionId: string, options?: { insertAfterTabId?: string | null }): void;

  /**
   * 프리뷰 탭을 고정 탭으로 변환 (isPreview → false).
   */
  pinTab(tabId: string): void;

  /**
   * 탭이 표시하는 세션을 기준으로 탭의 프로젝트 소유권을 보정.
   * All Projects의 빈 전역 탭에서 세션을 만든 뒤 실제 프로젝트 탭으로 귀속할 때 사용.
   */
  syncTabProjectFromSession(tabId: string, sessionId: string | null): void;

  /**
   * 주어진 세션이 열려 있는 탭과 패널을 찾음 (BR-007).
   * 활성 탭의 live 상태를 먼저 검색 후, 비활성 탭의 스냅샷을 순서대로 검색.
   * @returns 탭+패널 위치 또는 null (찾지 못한 경우)
   */
  findSessionLocation(sessionId: string): { tabId: string; panelId: string } | null;

  /**
   * 활성 탭의 현재 상태를 TabSnapshot으로 반환.
   * 항상 panel-store의 live 상태를 읽음 (stale 스냅샷 아님).
   */
  getActiveTabSnapshot(): TabSnapshot;

  /**
   * 현재 탭 상태를 localStorage에 저장.
   * 활성 탭의 live 상태를 포함 (BR-011).
   * 디바운스는 호출자(ChatLayout)가 관리함.
   */
  persistToLocalStorage(): void;

  /**
   * localStorage에서 탭 상태를 복원.
   * 레거시 패널 레이아웃 마이그레이션 포함 (BR-012).
   * 앱 마운트 시 ChatLayout의 useEffect에서 호출.
   */
  restoreFromLocalStorage(): void;

  /**
   * 프로젝트 전환. 현재 프로젝트의 탭 상태를 저장하고 대상 프로젝트의 탭 상태를 복원.
   * 대상 프로젝트에 저장된 상태가 없으면 빈 탭 1개로 초기화.
   * 이미 같은 프로젝트면 no-op.
   */
  switchProject(projectDir: string): void;

  /**
   * 프로젝트 삭제 시 해당 프로젝트의 탭 상태를 제거.
   */
  removeProjectTabs(projectDir: string): void;
}

/** tab-store 결합 타입 */
export type TabStore = TabStoreState & TabStoreActions;

// --- 영속성 DTO ---

/**
 * localStorage에 저장되는 탭 스냅샷 DTO.
 * 런타임 Tab과 구조적으로 동일하지만, 영속성 경계를 명확히 하기 위해 분리 선언.
 */
export interface PersistedTab {
  id: string;
  projectDir?: string | null;
  snapshot: TabSnapshot;
  title: string | null;
  isPreview: boolean;
}

/**
 * localStorage v1 포맷 — 단일 프로젝트 (레거시, 마이그레이션용).
 */
export interface PersistedTabStoreV1 {
  version: 1;
  tabs: PersistedTab[];
  activeTabId: string;
}

/**
 * localStorage v2 포맷 — 프로젝트별 탭 상태.
 * TAB_STORE_KEY 키 하에 저장됨.
 */
export interface PersistedTabStoreV2 {
  version: 2;
  /** 마지막 활성 프로젝트 디렉토리 */
  currentProjectDir: string | null;
  /** 프로젝트별 탭 상태. 키 = projectDir (encodedDir) */
  projects: Record<string, { tabs: PersistedTab[]; activeTabId: string }>;
}

/**
 * localStorage v3 포맷 — 탭마다 projectDir를 가지며 전역 탭을 별도 저장.
 */
export interface PersistedTabStoreV3 {
  version: 3;
  /** 마지막 선택 탭 스코프. 프로젝트 encodedDir 또는 All Projects sentinel. */
  currentProjectDir: string | null;
  /** 마지막 활성 탭. 현재 스코프에서 보이지 않으면 복원 시 대체됨. */
  activeTabId: string | null;
  /** 프로젝트별 탭 상태. 키 = projectDir (encodedDir) */
  projects: Record<string, { tabs: PersistedTab[]; activeTabId: string }>;
  /** 전역 탭 상태. 전역 탭이 없으면 null. */
  global: { tabs: PersistedTab[]; activeTabId: string } | null;
}

/** localStorage에 저장되는 탭 스토어 DTO (v1 | v2 | v3) */
export type PersistedTabStore = PersistedTabStoreV1 | PersistedTabStoreV2 | PersistedTabStoreV3;
