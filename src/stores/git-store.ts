import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { createUiJsonStorage } from '@/lib/persistence/zustand-ui-storage'

/** Which of the right-hand panel's tabs is showing. */
export type GitPanelTab = 'git' | 'files' | 'scripts' | 'memory'

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
  panelTab: GitPanelTab
  /** Monotonic request used to focus recovery even when the panel is open. */
  conflictRecoveryFocusRequest: number

  toggle: () => void
  open: () => void
  close: () => void
  setPanelWidth: (width: number) => void
  setDrawerOpen: (open: boolean) => void
  toggleDrawer: () => void
  setDrawerHeight: (height: number) => void
  setPanelTab: (tab: GitPanelTab) => void
  /** Open the panel and show one tab, whatever was showing before. */
  openTab: (tab: GitPanelTab) => void
  /** Open the Git tab and focus its conflict-recovery surface. */
  openConflictRecovery: () => void
}

type PersistedGitPanelUIState = Pick<
  GitPanelUIState,
  'isOpen' | 'panelWidth' | 'drawerHeight' | 'panelTab'
>

export const useGitStore = create<GitPanelUIState>()(
  persist(
    (set, get) => ({
      isOpen: false,
      panelWidth: 320,
      drawerOpen: false,
      drawerHeight: 320,
      panelTab: 'git',
      conflictRecoveryFocusRequest: 0,

      toggle: () => set({ isOpen: !get().isOpen }),
      open: () => set({ isOpen: true }),
      close: () => set({ isOpen: false }),
      setPanelWidth: (width) => set({ panelWidth: width }),
      setDrawerOpen: (open) => set({ drawerOpen: open }),
      toggleDrawer: () => set({ drawerOpen: !get().drawerOpen }),
      setDrawerHeight: (height) => set({ drawerHeight: height }),
      setPanelTab: (tab) => set({ panelTab: tab }),
      openTab: (tab) => set({ isOpen: true, panelTab: tab }),
      openConflictRecovery: () => set((state) => ({
        isOpen: true,
        panelTab: 'git',
        conflictRecoveryFocusRequest: state.conflictRecoveryFocusRequest + 1,
      })),
    }),
    {
      name: 'tessera:git-panel',
      storage: createUiJsonStorage<PersistedGitPanelUIState>(),
      partialize: (state) => ({
        isOpen: state.isOpen,
        panelWidth: state.panelWidth,
        drawerHeight: state.drawerHeight,
        panelTab: state.panelTab,
      }),
    }
  )
)
