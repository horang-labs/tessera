import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { createUiJsonStorage } from '@/lib/persistence/zustand-ui-storage'

/** Which of the right-hand panel's tabs is showing. */
export type GitPanelTab = 'git' | 'files' | 'scripts' | 'memory' | 'images'

interface GitPanelUIState {
  isOpen: boolean
  panelWidth: number
  drawerOpen: boolean
  drawerHeight: number
  /**
   * Kept here rather than inside the panel so that anything with a reason to
   * send the user to a particular tab — a preparation badge, a worktree that
   * has just been created — can open the panel on it.
   */
  /** Selection for a panel without a session; also reads legacy persisted state. */
  panelTab: GitPanelTab
  panelTabsBySessionId: Record<string, GitPanelTab>
  getPanelTab: (sessionId: string | null) => GitPanelTab
  /** Monotonic request used to focus recovery even when the panel is open. */
  conflictRecoveryFocusRequest: number

  toggle: () => void
  open: () => void
  close: () => void
  setPanelWidth: (width: number) => void
  setDrawerOpen: (open: boolean) => void
  toggleDrawer: () => void
  setDrawerHeight: (height: number) => void
  setPanelTab: (tab: GitPanelTab, sessionId?: string | null) => void
  /** Open the panel and show one tab, whatever was showing before. */
  openTab: (tab: GitPanelTab, sessionId?: string | null) => void
  /** Open the Git tab and focus its conflict-recovery surface. */
  openConflictRecovery: (sessionId?: string | null) => void
}

type PersistedGitPanelUIState = Pick<
  GitPanelUIState,
  'isOpen' | 'panelWidth' | 'drawerHeight' | 'panelTab' | 'panelTabsBySessionId'
>

export const useGitStore = create<GitPanelUIState>()(
  persist(
    (set, get) => ({
      isOpen: false,
      panelWidth: 320,
      drawerOpen: false,
      drawerHeight: 320,
      panelTab: 'git',
      panelTabsBySessionId: {},
      getPanelTab: (sessionId) => sessionId
        ? get().panelTabsBySessionId[sessionId] ?? 'git'
        : get().panelTab,
      conflictRecoveryFocusRequest: 0,

      toggle: () => set({ isOpen: !get().isOpen }),
      open: () => set({ isOpen: true }),
      close: () => set({ isOpen: false }),
      setPanelWidth: (width) => set({ panelWidth: width }),
      setDrawerOpen: (open) => set({ drawerOpen: open }),
      toggleDrawer: () => set({ drawerOpen: !get().drawerOpen }),
      setDrawerHeight: (height) => set({ drawerHeight: height }),
      setPanelTab: (tab, sessionId) => set((state) => sessionId
        ? { panelTabsBySessionId: { ...state.panelTabsBySessionId, [sessionId]: tab } }
        : { panelTab: tab }),
      openTab: (tab, sessionId) => {
        get().setPanelTab(tab, sessionId);
        set({ isOpen: true });
      },
      openConflictRecovery: (sessionId) => {
        get().setPanelTab('git', sessionId);
        set((state) => ({
          isOpen: true,
          conflictRecoveryFocusRequest: state.conflictRecoveryFocusRequest + 1,
        }));
      },
    }),
    {
      name: 'tessera:git-panel',
      storage: createUiJsonStorage<PersistedGitPanelUIState>(),
      partialize: (state) => ({
        isOpen: state.isOpen,
        panelWidth: state.panelWidth,
        drawerHeight: state.drawerHeight,
        panelTab: state.panelTab,
        panelTabsBySessionId: state.panelTabsBySessionId,
      }),
    }
  )
)
