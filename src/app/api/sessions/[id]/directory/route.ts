import { NextRequest, NextResponse } from "next/server";
import { requireAuthenticatedUserId } from "@/lib/auth/api-auth";
import { jsonError } from "@/lib/http/json-error";
import logger from "@/lib/logger";
import { resolveSessionWorkspaceFilesystemRoot } from "@/lib/session/session-workspace-root";
import { WorkspaceFileError } from "@/lib/workspace-files/workspace-file-io";
import { createWorkspaceDirectory } from "@/lib/workspace-files/workspace-file-mutations";

interface WorkspaceDirectoryBody {
  path?: unknown;
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;

  try {
    // Authenticate before reading the body, as the sibling file route does: an
    // unauthenticated caller should not get as far as having its payload parsed.
    const auth = await requireAuthenticatedUserId(request, {
      error: { code: "unauthorized", message: "Unauthorized" },
    });
    if ("response" in auth) return auth.response;

    const root = await resolveSessionWorkspaceFilesystemRoot(id);
    if (!root) {
      return jsonError("missing_work_dir", "Session has no working directory", 422);
    }

    const body = (await request.json().catch(() => null) ?? {}) as WorkspaceDirectoryBody;
    if (typeof body.path !== "string") {
      throw new WorkspaceFileError("invalid_file_path", "Missing folder path", 400);
    }

    const created = await createWorkspaceDirectory(root, { path: body.path });
    return NextResponse.json({
      sessionId: id,
      path: created.relativePath,
      created: true,
    });
  } catch (error) {
    if (error instanceof WorkspaceFileError) {
      return jsonError(error.code, error.message, error.status);
    }
    logger.error({ error, sessionId: id }, "Failed to create workspace folder");
    return jsonError("internal_error", "Failed to create workspace folder", 500);
  }
}
