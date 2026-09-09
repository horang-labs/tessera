import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { createUiJsonStorage } from '@/lib/persistence/zustand-ui-storage';

interface WorkspaceFileViewState {
  /** Whether dotfiles/dotfolders (e.g. .github, .env, .claude) are shown in the
   * workspace file tree. Build/VCS output dirs stay hidden regardless. */
  showHiddenFiles: boolean;
  /** Expanded directory paths, isolated by canonical Session/Worktree target. */
  expandedPathsByWorkspace: Record<string, string[]>;
  toggleShowHiddenFiles: () => void;
  setShowHiddenFiles: (value: boolean) => void;
  setExpandedPaths: (workspaceKey: string, paths: Iterable<string>) => void;
  expandPath: (workspaceKey: string, path: string) => void;
  toggleExpandedPath: (workspaceKey: string, path: string) => void;
}

type PersistedWorkspaceFileViewState = Pick<
  WorkspaceFileViewState,
  'showHiddenFiles' | 'expandedPathsByWorkspace'
>;

const EMPTY_EXPANDED_PATHS: string[] = [];

export const useWorkspaceFileViewStore = create<WorkspaceFileViewState>()(
  persist(
    (set) => ({
      showHiddenFiles: false,
      expandedPathsByWorkspace: {},
      toggleShowHiddenFiles: () =>
        set((state) => ({ showHiddenFiles: !state.showHiddenFiles })),
      setShowHiddenFiles: (value) => set({ showHiddenFiles: value }),
      setExpandedPaths: (workspaceKey, paths) =>
        set((state) => ({
          expandedPathsByWorkspace: {
            ...state.expandedPathsByWorkspace,
            [workspaceKey]: Array.from(paths),
          },
        })),
      expandPath: (workspaceKey, path) => {
        if (!path) return;
        set((state) => {
          const next = new Set(state.expandedPathsByWorkspace[workspaceKey]);
          let walked = '';
          for (const part of path.split('/')) {
            walked = walked ? `${walked}/${part}` : part;
            next.add(walked);
          }
          return {
            expandedPathsByWorkspace: {
              ...state.expandedPathsByWorkspace,
              [workspaceKey]: Array.from(next),
            },
          };
        });
      },
      toggleExpandedPath: (workspaceKey, path) =>
        set((state) => {
          const next = new Set(state.expandedPathsByWorkspace[workspaceKey]);
          if (next.has(path)) next.delete(path);
          else next.add(path);
          return {
            expandedPathsByWorkspace: {
              ...state.expandedPathsByWorkspace,
              [workspaceKey]: Array.from(next),
            },
          };
        }),
    }),
    {
      name: 'tessera:workspace-file-view',
      storage: createUiJsonStorage<PersistedWorkspaceFileViewState>(),
      partialize: (state) => ({
        showHiddenFiles: state.showHiddenFiles,
        expandedPathsByWorkspace: state.expandedPathsByWorkspace,
      }),
    },
  ),
);

export const selectExpandedWorkspacePaths = (workspaceKey: string | null) =>
  (state: WorkspaceFileViewState): string[] =>
    workspaceKey
      ? state.expandedPathsByWorkspace[workspaceKey] ?? EMPTY_EXPANDED_PATHS
      : EMPTY_EXPANDED_PATHS;
