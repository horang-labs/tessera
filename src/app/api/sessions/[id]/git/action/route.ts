import { NextRequest, NextResponse } from "next/server";
import { requireAuthenticatedUserId } from "@/lib/auth/api-auth";
import {
  GitActionRejection,
  type GitAction,
  type GitActionRejectionCode,
} from "@/lib/git/git-actions";
import { GitPanelError } from "@/lib/git/git-panel";
import { runSessionGitAction } from "@/lib/git/session-git-action";
import { jsonError } from "@/lib/http/json-error";
import logger from "@/lib/logger";

/**
 * Runs one Git action for a session. The working directory is looked up here
 * from the session id, never taken from the request, and the execution module
 * validates every file path against the current change set.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;

  try {
    const auth = await requireAuthenticatedUserId(request, {
      error: { code: "unauthorized", message: "Unauthorized" },
    });
    if ("response" in auth) return auth.response;

    const parsed = parseGitActionBody(await request.json().catch(() => null));
    if ("message" in parsed) {
      return jsonError("invalid_request", parsed.message, 400);
    }

    // Resolving the working directory, running the action and triggering the
    // state refresh all live behind this call (§11); the route only decides how
    // the outcome is written to the wire.
    const result = await runSessionGitAction(id, auth.userId, parsed.action);

    // A Git failure is an outcome of the request, not a broken request, and
    // ADR 0005 requires its detail to reach the client intact. `jsonError`
    // would flatten the classified kind and the stderr away, so the structured
    // result answers instead and the client branches on `ok`.
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof GitActionRejection) {
      const { code, status } = describeRejection(error.code);
      return jsonError(code, error.message, status);
    }
    if (error instanceof GitPanelError) {
      return jsonError(error.code, error.message, error.status);
    }

    logger.error({ error, sessionId: id }, "Failed to run git action");
    return jsonError("internal_error", "Failed to run git action", 500);
  }
}

function describeRejection(
  code: GitActionRejectionCode,
): { code: string; status: number } {
  // A path that is not in the change set answers the way the single-file diff
  // route already answers the same situation.
  if (code === "file_not_in_change_set") {
    return { code: "invalid_file_path", status: 404 };
  }
  // The request was well formed and the repository is what refuses it — the
  // ladder already declines to offer these, so this only catches a click that
  // raced the state it was derived from.
  if (code === "detached_head" || code === "no_remote" || code === "no_upstream") {
    return { code, status: 409 };
  }
  return { code: "invalid_request", status: 400 };
}

/**
 * Shape-checks the request body. The execution module re-checks the parts that
 * matter — an empty message is refused there too, which is the second guard
 * `docs/design/git-delivery.md` §5 asks for.
 */
function parseGitActionBody(
  body: unknown,
): { action: GitAction } | { message: string } {
  if (typeof body !== "object" || body === null) {
    return { message: "A git action body is required" };
  }

  const { action, message, files } = body as {
    action?: unknown;
    message?: unknown;
    files?: unknown;
  };

  // Push and pull take no parameters at all: which branch moves, to or from
  // where, is read from the repository and never asked for by the client.
  if (action === "push") {
    return { action: { action: "push" } };
  }
  if (action === "pull") {
    return { action: { action: "pull" } };
  }
  if (action !== "commit") {
    return { message: `Unsupported git action: ${String(action)}` };
  }
  if (typeof message !== "string") {
    return { message: "A commit message is required" };
  }
  if (!Array.isArray(files) || files.some((file) => typeof file !== "string")) {
    return { message: "A list of file paths is required" };
  }

  return { action: { action: "commit", message, files: files as string[] } };
}
