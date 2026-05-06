import { NextRequest, NextResponse } from "next/server";
import { requireAuthenticatedUserId } from "@/lib/auth/api-auth";
import { getGitDiffData, GitPanelError } from "@/lib/git/git-panel";
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

    const filePath = request.nextUrl.searchParams.get("path") ?? "";
    const payload = await getGitDiffData(id, filePath, auth.userId);
    return NextResponse.json(payload);
  } catch (error) {
    if (error instanceof GitPanelError) {
      return jsonError(error.code, error.message, error.status);
    }

    logger.error({ error, sessionId: id }, "Failed to load git diff data");
    return jsonError("internal_error", "Failed to load git diff data", 500);
  }
}
