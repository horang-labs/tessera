import { extractGitPanelErrorMessage } from "@/components/git/git-panel-shared";
import { fetchWithTimeout, isTimeoutError } from "@/lib/api/fetch-with-timeout";
import { workspaceTargetApiPath, type WorkspaceTarget } from '@/types/worktree';

/**
 * A tree mutation touches the workspace filesystem, which can be a 9P share or
 * a network mount; the server gives up at 2 s, so the client waits a little
 * longer than that before calling it unresponsive.
 */
const MUTATION_TIMEOUT_MS = 3_000;

interface MutationErrorPayload {
  error?: { code?: string; message?: string };
}

async function requestMutation<T>(
  url: string,
  init: RequestInit,
  fallbackMessage: string,
  timeoutMessage: string,
  timeoutMs: number = MUTATION_TIMEOUT_MS,
): Promise<T> {
  let response: Response;
  try {
    response = await fetchWithTimeout(url, { ...init, timeoutMs });
  } catch (caught) {
    if (isTimeoutError(caught)) throw new Error(timeoutMessage);
    throw caught instanceof Error ? caught : new Error(fallbackMessage);
  }

  const payload = (await response.json().catch(() => null)) as (T & MutationErrorPayload) | null;
  if (!response.ok || !payload) {
    // The code rides along so a caller can react to one failure (the Trash being
    // unavailable) without matching on message text.
    throw Object.assign(new Error(extractGitPanelErrorMessage(payload, fallbackMessage)), {
      code: payload?.error?.code,
    });
  }
  return payload;
}

function targetUrl(target: WorkspaceTarget, suffix: string): string {
  return `${workspaceTargetApiPath(target)}/${suffix}`;
}

/**
 * Creates an empty file. The route writes with the `wx` flag, so a name that is
 * already taken comes back as a 409 rather than replacing what is there.
 */
export async function createWorkspaceFileRequest(
  target: WorkspaceTarget,
  path: string,
): Promise<{ path: string }> {
  return requestMutation<{ path: string }>(
    targetUrl(target, "file"),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path, content: "" }),
    },
    "Failed to create file.",
    "The file was not created in time. The workspace filesystem may be unresponsive.",
  );
}

export async function createWorkspaceDirectoryRequest(
  target: WorkspaceTarget,
  path: string,
): Promise<{ path: string }> {
  return requestMutation<{ path: string }>(
    targetUrl(target, "directory"),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path }),
    },
    "Failed to create folder.",
    "The folder was not created in time. The workspace filesystem may be unresponsive.",
  );
}

export async function renameWorkspaceEntryRequest(
  target: WorkspaceTarget,
  path: string,
  newName: string,
): Promise<{ path: string; previousPath: string }> {
  return requestMutation<{ path: string; previousPath: string }>(
    targetUrl(target, "file"),
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path, newName }),
    },
    "Failed to rename.",
    "The rename did not finish in time. The workspace filesystem may be unresponsive.",
  );
}

export async function deleteWorkspaceEntryRequest(
  target: WorkspaceTarget,
  path: string,
  options: { recursive: boolean; trash?: boolean },
): Promise<{ path: string }> {
  const search = new URLSearchParams({ path });
  // The server sends the entry to the OS trash rather than removing it.
  if (options.trash) search.set("trash", "1");
  // Only a folder delete carries `recursive`, and the UI only sends it once the
  // confirmation has said the contents go with it.
  if (options.recursive) search.set("recursive", "1");
  return requestMutation<{ path: string }>(
    `${targetUrl(target, "file")}?${search.toString()}`,
    { method: "DELETE" },
    "Failed to delete.",
    "The delete did not finish in time. The workspace filesystem may be unresponsive.",
  );
}

/** Copying a tree or writing uploads takes longer than a single metadata call. */
const BULK_MUTATION_TIMEOUT_MS = 65_000;

export interface WorkspaceTransferResponse {
  operation: "move" | "copy";
  entries: Array<{ from: string; to: string; kind: "file" | "directory" }>;
}

/**
 * Move or copy entries into a destination folder (`""` is the workspace root).
 * A move never overwrites; a copy that would clash is given a free "copy" name.
 */
export async function transferWorkspaceEntriesRequest(
  target: WorkspaceTarget,
  operation: "move" | "copy",
  sources: readonly string[],
  destination: string,
): Promise<WorkspaceTransferResponse> {
  return requestMutation<WorkspaceTransferResponse>(
    targetUrl(target, "transfer"),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ operation, sources, destination }),
    },
    operation === "move" ? "Failed to move." : "Failed to copy.",
    "The operation did not finish in time. The workspace filesystem may be unresponsive.",
    BULK_MUTATION_TIMEOUT_MS,
  );
}

export async function uploadWorkspaceFilesRequest(
  target: WorkspaceTarget,
  destination: string,
  items: ReadonlyArray<{ file: File; path: string }>,
): Promise<{ paths: string[] }> {
  const form = new FormData();
  form.set("destination", destination);
  for (const item of items) {
    form.append("files", item.file, item.file.name);
    form.append("paths", item.path);
  }
  return requestMutation<{ paths: string[] }>(
    targetUrl(target, "upload"),
    { method: "POST", body: form },
    "Failed to upload.",
    "The upload did not finish in time. The workspace filesystem may be unresponsive.",
    BULK_MUTATION_TIMEOUT_MS,
  );
}

/** What the OS calls its trash for this workspace, or null when the path has none (WSL). */
export async function fetchWorkspaceTrashLabel(target: WorkspaceTarget): Promise<string | null> {
  try {
    const response = await fetchWithTimeout(targetUrl(target, "trash"), { timeoutMs: MUTATION_TIMEOUT_MS });
    if (!response.ok) return null;
    return ((await response.json()) as { label?: string | null }).label ?? null;
  } catch {
    return null;
  }
}
