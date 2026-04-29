import { create } from 'zustand'
import { persist } from 'zustand/middleware'

interface GitPanelUIState {
  isOpen: boolean
  panelWidth: number
  drawerOpen: boolean
  drawerHeight: number

  toggle: () => void
  close: () => void
  setPanelWidth: (width: number) => void
  setDrawerOpen: (open: boolean) => void
  toggleDrawer: () => void
  setDrawerHeight: (height: number) => void
}

export const useGitStore = create<GitPanelUIState>()(
  persist(
    (set, get) => ({
      isOpen: false,
      panelWidth: 320,
      drawerOpen: false,
      drawerHeight: 320,

      toggle: () => set({ isOpen: !get().isOpen }),
      close: () => set({ isOpen: false }),
      setPanelWidth: (width) => set({ panelWidth: width }),
      setDrawerOpen: (open) => set({ drawerOpen: open }),
      toggleDrawer: () => set({ drawerOpen: !get().drawerOpen }),
      setDrawerHeight: (height) => set({ drawerHeight: height }),
    }),
    {
      name: 'tessera:git-panel',
      partialize: (state) => ({
        isOpen: state.isOpen,
        panelWidth: state.panelWidth,
        drawerHeight: state.drawerHeight,
      }),
    }
  )
)
