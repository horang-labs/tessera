import { NextRequest, NextResponse } from "next/server";
import { requireAuthenticatedUserId } from "@/lib/auth/api-auth";
import * as dbSessions from '@/lib/db/sessions';
import {
  CommitMessageGenerationError,
} from "@/lib/git/commit-message-generator";
import {
  generateConfiguredCommitMessage,
  parseSelectedFiles,
} from '@/lib/git/git-commit-message-service';
import { GitActionRejection } from "@/lib/git/git-actions";
import { GitPanelError, resolveSessionGitTarget } from "@/lib/git/git-panel";
import { jsonError } from "@/lib/http/json-error";
import logger from "@/lib/logger";

/**
 * Writes a commit message from the files the panel currently has selected. It
 * changes nothing — no Git action runs and no state refresh is triggered — so
 * this sits beside the action route rather than inside it.
 *
 * The model call goes down the one-shot provider path session titles use, not
 * through the session's agent, so an agent busy with something else can neither
 * delay nor block it (ADR 0005).
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

    const files = parseSelectedFiles(await request.json().catch(() => null));
    if ("message" in files) {
      return jsonError("invalid_request", files.message, 400);
    }

    const target = await resolveSessionGitTarget(id, auth.userId);
    const message = await generateConfiguredCommitMessage(
      target,
      auth.userId,
      files.files,
      dbSessions.getSession(id)?.provider?.trim(),
    );

    return NextResponse.json({ message });
  } catch (error) {
    if (error instanceof GitActionRejection) {
      const status = error.code === "file_not_in_change_set" ? 404 : 400;
      const code =
        error.code === "file_not_in_change_set"
          ? "invalid_file_path"
          : "invalid_request";
      return jsonError(code, error.message, status);
    }
    if (error instanceof GitPanelError) {
      return jsonError(error.code, error.message, error.status);
    }
    if (error instanceof CommitMessageGenerationError) {
      // The request was fine and the repository is untouched — the model call
      // is what failed. The panel reports this on the generate button alone and
      // leaves committing available.
      logger.warn({ error, sessionId: id }, "Commit message generation failed");
      return jsonError("generation_failed", error.message, 502);
    }

    logger.error({ error, sessionId: id }, "Failed to generate a commit message");
    return jsonError("internal_error", "Failed to generate a commit message", 500);
  }
}
