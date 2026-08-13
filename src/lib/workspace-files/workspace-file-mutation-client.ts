import { extractGitPanelErrorMessage } from "@/components/git/git-panel-shared";
import { fetchWithTimeout, isTimeoutError } from "@/lib/api/fetch-with-timeout";

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
): Promise<T> {
  let response: Response;
  try {
    response = await fetchWithTimeout(url, { ...init, timeoutMs: MUTATION_TIMEOUT_MS });
  } catch (caught) {
    if (isTimeoutError(caught)) throw new Error(timeoutMessage);
    throw caught instanceof Error ? caught : new Error(fallbackMessage);
  }

  const payload = (await response.json().catch(() => null)) as (T & MutationErrorPayload) | null;
  if (!response.ok || !payload) {
    throw new Error(extractGitPanelErrorMessage(payload, fallbackMessage));
  }
  return payload;
}

function sessionUrl(sessionId: string, suffix: string): string {
  return `/api/sessions/${encodeURIComponent(sessionId)}/${suffix}`;
}

/**
 * Creates an empty file. The route writes with the `wx` flag, so a name that is
 * already taken comes back as a 409 rather than replacing what is there.
 */
export async function createWorkspaceFileRequest(
  sessionId: string,
  path: string,
): Promise<{ path: string }> {
  return requestMutation<{ path: string }>(
    sessionUrl(sessionId, "file"),
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
  sessionId: string,
  path: string,
): Promise<{ path: string }> {
  return requestMutation<{ path: string }>(
    sessionUrl(sessionId, "directory"),
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
  sessionId: string,
  path: string,
  newName: string,
): Promise<{ path: string; previousPath: string }> {
  return requestMutation<{ path: string; previousPath: string }>(
    sessionUrl(sessionId, "file"),
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
  sessionId: string,
  path: string,
  options: { recursive: boolean },
): Promise<{ path: string }> {
  const search = new URLSearchParams({ path });
  // Only a folder delete carries `recursive`, and the UI only sends it once the
  // confirmation has said the contents go with it.
  if (options.recursive) search.set("recursive", "1");
  return requestMutation<{ path: string }>(
    `${sessionUrl(sessionId, "file")}?${search.toString()}`,
    { method: "DELETE" },
    "Failed to delete.",
    "The delete did not finish in time. The workspace filesystem may be unresponsive.",
  );
}
