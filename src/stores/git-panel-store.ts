import { create } from 'zustand';
import type {
  GitActionFailureReport,
  GitActionVerb,
} from '@/components/git/git-action-report';
import type { GitPanelData } from '@/types/git';

export type GitPendingVerb = GitActionVerb | 'commit_push' | 'publish';

export interface WorktreeGitDeliveryState {
  commitMessage: string;
  /** Checkboxes default on, so only explicit exclusions belong in the draft. */
  deselectedPaths: ReadonlySet<string>;
  pendingVerb: GitPendingVerb | null;
  actionFailure: GitActionFailureReport | null;
}

interface GitPanelStoreState {
  /** Latest git panel data per session, populated by both REST loads and
   *  server-pushed `git_panel_state` messages. */
  dataBySessionId: Record<string, GitPanelData>;

  /** Canonical Git worktree identity resolved from each session's latest snapshot. */
  worktreeKeyBySessionId: Record<string, string>;

  /** One delivery owner shared by every session on the same Git worktree. */
  deliveryByWorktree: Record<string, WorktreeGitDeliveryState>;

  /** Replace the data for a session. Skipped when the payload is identical
   *  by reference. */
  applyGitPanelData: (sessionId: string, data: GitPanelData) => void;

  setCommitMessage: (worktreeKey: string, message: string) => void;
  setCommitFilesSelected: (
    worktreeKey: string,
    paths: readonly string[],
    selected: boolean,
  ) => void;
  clearDraft: (worktreeKey: string) => void;
  markPending: (worktreeKey: string, verb: GitPendingVerb | null) => void;
  setActionFailure: (
    worktreeKey: string,
    failure: GitActionFailureReport | null,
  ) => void;

  /** Drop a session entry (e.g. when a session is closed). */
  clearSession: (sessionId: string) => void;
}

function emptyDeliveryState(): WorktreeGitDeliveryState {
  return {
    commitMessage: '',
    deselectedPaths: new Set<string>(),
    pendingVerb: null,
    actionFailure: null,
  };
}

/** `repoRoot` is returned by `git rev-parse --show-toplevel`: the worktree root. */
export function gitWorktreeKey(data: GitPanelData): string {
  return data.repoRoot || data.worktreePath || data.workDir;
}

/**
 * A short-lived owner used only while the first snapshot is resolving.
 * The panel already permits typing in that frame; `applyGitPanelData` moves any
 * such input onto the canonical worktree owner as soon as Git names it.
 */
export function provisionalGitWorktreeKey(sessionId: string): string {
  return `session:${sessionId}`;
}

function reconcileDeliveryState(
  current: WorktreeGitDeliveryState,
  data: GitPanelData,
): WorktreeGitDeliveryState {
  if (data.changedFiles.length === 0) {
    if (!current.commitMessage && current.deselectedPaths.size === 0) return current;
    return {
      ...current,
      commitMessage: '',
      deselectedPaths: new Set<string>(),
    };
  }

  if (current.deselectedPaths.size === 0) return current;
  const changedPaths = new Set(data.changedFiles.map((file) => file.path));
  const deselectedPaths = new Set(
    [...current.deselectedPaths].filter((path) => changedPaths.has(path)),
  );
  return deselectedPaths.size === current.deselectedPaths.size
    ? current
    : { ...current, deselectedPaths };
}

export const useGitPanelStore = create<GitPanelStoreState>((set) => ({
  dataBySessionId: {},
  worktreeKeyBySessionId: {},
  deliveryByWorktree: {},

  applyGitPanelData: (sessionId, data) => {
    set((state) => {
      const worktreeKey = gitWorktreeKey(data);
      const provisionalKey = provisionalGitWorktreeKey(sessionId);
      const provisionalDelivery = state.deliveryByWorktree[provisionalKey];
      if (
        state.dataBySessionId[sessionId] === data
        && state.worktreeKeyBySessionId[sessionId] === worktreeKey
        && !provisionalDelivery
      ) {
        return state;
      }
      const canonicalDelivery =
        state.deliveryByWorktree[worktreeKey] ?? emptyDeliveryState();
      // Before the first snapshot the only editable delivery field is the
      // message. Merge that edit into the already-shared owner; adopting the
      // provisional entry wholesale would erase another surface's exclusions,
      // pending lock, and retained failure.
      const currentDelivery = provisionalDelivery
        ? {
          ...canonicalDelivery,
          commitMessage: provisionalDelivery.commitMessage,
        }
        : canonicalDelivery;
      const nextDelivery = reconcileDeliveryState(currentDelivery, data);
      const deliveryByWorktree = { ...state.deliveryByWorktree };
      delete deliveryByWorktree[provisionalKey];
      deliveryByWorktree[worktreeKey] = nextDelivery;
      return {
        dataBySessionId: {
          ...state.dataBySessionId,
          [sessionId]: data,
        },
        worktreeKeyBySessionId: {
          ...state.worktreeKeyBySessionId,
          [sessionId]: worktreeKey,
        },
        deliveryByWorktree,
      };
    });
  },

  setCommitMessage: (worktreeKey, commitMessage) => {
    set((state) => ({
      deliveryByWorktree: {
        ...state.deliveryByWorktree,
        [worktreeKey]: {
          ...(state.deliveryByWorktree[worktreeKey] ?? emptyDeliveryState()),
          commitMessage,
        },
      },
    }));
  },

  setCommitFilesSelected: (worktreeKey, paths, selected) => {
    set((state) => {
      const current = state.deliveryByWorktree[worktreeKey] ?? emptyDeliveryState();
      const deselectedPaths = new Set(current.deselectedPaths);
      for (const path of paths) {
        if (selected) deselectedPaths.delete(path);
        else deselectedPaths.add(path);
      }
      return {
        deliveryByWorktree: {
          ...state.deliveryByWorktree,
          [worktreeKey]: { ...current, deselectedPaths },
        },
      };
    });
  },

  clearDraft: (worktreeKey) => {
    set((state) => {
      const current = state.deliveryByWorktree[worktreeKey] ?? emptyDeliveryState();
      if (!current.commitMessage && current.deselectedPaths.size === 0) return state;
      return {
        deliveryByWorktree: {
          ...state.deliveryByWorktree,
          [worktreeKey]: {
            ...current,
            commitMessage: '',
            deselectedPaths: new Set<string>(),
          },
        },
      };
    });
  },

  markPending: (worktreeKey, pendingVerb) => {
    set((state) => {
      const current = state.deliveryByWorktree[worktreeKey] ?? emptyDeliveryState();
      return {
        deliveryByWorktree: {
          ...state.deliveryByWorktree,
          [worktreeKey]: {
            ...current,
            pendingVerb,
            // A new action replaces the retained report from the last attempt.
            actionFailure: pendingVerb ? null : current.actionFailure,
          },
        },
      };
    });
  },

  setActionFailure: (worktreeKey, actionFailure) => {
    set((state) => ({
      deliveryByWorktree: {
        ...state.deliveryByWorktree,
        [worktreeKey]: {
          ...(state.deliveryByWorktree[worktreeKey] ?? emptyDeliveryState()),
          actionFailure,
        },
      },
    }));
  },

  clearSession: (sessionId) => {
    set((state) => {
      if (!(sessionId in state.dataBySessionId)) return state;
      const { [sessionId]: _removed, ...rest } = state.dataBySessionId;
      const { [sessionId]: _removedKey, ...restKeys } =
        state.worktreeKeyBySessionId;
      // The worktree owner deliberately survives a session disappearing: another
      // session can still be presenting the same physical checkout.
      return { dataBySessionId: rest, worktreeKeyBySessionId: restKeys };
    });
  },
}));
