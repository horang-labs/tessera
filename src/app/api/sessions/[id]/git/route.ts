import { NextRequest, NextResponse } from "next/server";
import { requireAuthenticatedUserId } from "@/lib/auth/api-auth";
import { getGitPanelData, GitPanelError } from "@/lib/git/git-panel";
import { scheduleGitRemoteRefresh } from "@/lib/git/git-remote-refresh";
import { jsonError } from "@/lib/http/json-error";
import logger from "@/lib/logger";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;

  try {
    const auth = await requireAuthenticatedUserId(request, {
      error: { code: "unauthorized", message: "Unauthorized" },
    });
    if ("response" in auth) return auth.response;

    const payload = await getGitPanelData(id, auth.userId);

    // The read itself stays local — this answers with what the refs say now,
    // and moves them behind the response for whoever reads next (#239). It is
    // rate-limited per working directory, so the panel's 5s poll does not mean
    // a fetch every 5s; the response is never delayed by it.
    void scheduleGitRemoteRefresh({
      sessionId: id,
      workDir: payload.workDir,
      userId: auth.userId,
    });

    return NextResponse.json(payload);
  } catch (error) {
    if (error instanceof GitPanelError) {
      return jsonError(error.code, error.message, error.status);
    }

    logger.error({ error, sessionId: id }, "Failed to load git panel data");
    return jsonError("internal_error", "Failed to load git panel data", 500);
  }
}
