import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface WorkspaceFileViewState {
  /** Whether dotfiles/dotfolders (e.g. .github, .env, .claude) are shown in the
   * workspace file tree. Build/VCS output dirs stay hidden regardless. */
  showHiddenFiles: boolean;
  toggleShowHiddenFiles: () => void;
  setShowHiddenFiles: (value: boolean) => void;
}

export const useWorkspaceFileViewStore = create<WorkspaceFileViewState>()(
  persist(
    (set) => ({
      showHiddenFiles: false,
      toggleShowHiddenFiles: () =>
        set((state) => ({ showHiddenFiles: !state.showHiddenFiles })),
      setShowHiddenFiles: (value) => set({ showHiddenFiles: value }),
    }),
    { name: 'tessera:workspace-file-view' },
  ),
);
