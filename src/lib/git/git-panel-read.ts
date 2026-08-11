/**
 * The one read behind every Git panel refresh — mount, focus and poll alike.
 *
 * It exists because the poll used to read something else. `/git/changes` answers
 * with the change set and nothing more, so a branch switched outside Tessera, or
 * a fetch that moved the behind count, stayed invisible until the panel was
 * remounted (#239) — and the whole primary-action ladder is derived from those
 * two values (`docs/design/git-delivery.md` §3). Keeping the read in one place is
 * what makes a remount unable to show anything a poll cannot.
 */

import { extractGitPanelErrorMessage } from "@/components/git/git-panel-shared";
import type { GitPanelData } from "@/types/git";
import { workspaceTargetApiPath, type WorkspaceTarget } from '@/types/worktree';

/**
 * What a panel read answers with. A failure is a value rather than a thrown
 * error because two of the three outcomes are ordinary: a session that is not
 * in the database yet is not a problem to report, and a failed silent refresh
 * must leave the panel showing what it already had.
 */
export type GitPanelRead =
  | { kind: "loaded"; data: GitPanelData }
  /**
   * The session id resolved on the client before its database row was visible
   * (`use-session-crud.ts` creates it optimistically). Nothing to say — the next
   * read finds it.
   */
  | { kind: "session_missing" }
  | { kind: "failed"; message: string };

export const GIT_PANEL_READ_FALLBACK_MESSAGE = "Failed to load git summary.";

export interface GitPanelReadOptions {
  /** The network boundary, injectable so a read can be exercised without one. */
  fetchImpl?: typeof fetch;
}

export function gitPanelReadPath(target: string | WorkspaceTarget): string {
  const resolved = typeof target === 'string'
    ? { kind: 'session', id: target } as const
    : target;
  return `${workspaceTargetApiPath(resolved)}/git`;
}

export function gitPanelDiffPath(
  target: string | WorkspaceTarget,
  filePath: string,
): string {
  return `${gitPanelReadPath(target)}/diff?path=${encodeURIComponent(filePath)}`;
}

export async function readGitPanelState(
  target: string | WorkspaceTarget,
  options: GitPanelReadOptions = {},
): Promise<GitPanelRead> {
  const fetchImpl = options.fetchImpl ?? fetch;

  try {
    const response = await fetchImpl(gitPanelReadPath(target));
    const payload = await response.json().catch(() => ({}));

    if (response.ok) {
      return { kind: "loaded", data: payload as GitPanelData };
    }

    if (response.status === 404 && readErrorCode(payload) === "session_not_found") {
      return { kind: "session_missing" };
    }

    return {
      kind: "failed",
      message: extractGitPanelErrorMessage(
        payload,
        GIT_PANEL_READ_FALLBACK_MESSAGE,
      ),
    };
  } catch (error) {
    return {
      kind: "failed",
      message:
        error instanceof Error ? error.message : GIT_PANEL_READ_FALLBACK_MESSAGE,
    };
  }
}

function readErrorCode(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const error = (payload as { error?: unknown }).error;
  if (typeof error !== "object" || error === null) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}
