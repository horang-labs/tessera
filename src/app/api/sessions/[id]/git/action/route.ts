import { NextRequest, NextResponse } from "next/server";
import { requireAuthenticatedUserId } from "@/lib/auth/api-auth";
import {
  GitActionRejection,
} from "@/lib/git/git-actions";
import {
  describeGitActionRejection,
  parseGitActionBody,
} from '@/lib/git/git-action-request';
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
      const { code, status } = describeGitActionRejection(error.code);
      return jsonError(code, error.message, status);
    }
    if (error instanceof GitPanelError) {
      return jsonError(error.code, error.message, error.status);
    }

    logger.error({ error, sessionId: id }, "Failed to run git action");
    return jsonError("internal_error", "Failed to run git action", 500);
  }
}
