import { create } from 'zustand';

export interface WorktreePeekTarget {
  kind: 'worktree';
  worktreeId: string;
  projectDir: string;
}

interface WorkspacePeekState {
  target: WorktreePeekTarget | null;
  openWorktree: (worktreeId: string, projectDir: string) => void;
  close: () => void;
}

export const useWorkspacePeekStore = create<WorkspacePeekState>()((set) => ({
  target: null,
  openWorktree: (worktreeId, projectDir) => set({
    target: { kind: 'worktree', worktreeId, projectDir },
  }),
  close: () => set({ target: null }),
}));
