import { NextRequest, NextResponse } from "next/server";
import * as fs from "fs/promises";
import * as path from "path";
import { requireAuthenticatedUserId } from "@/lib/auth/api-auth";
import { jsonError } from "@/lib/http/json-error";
import logger from "@/lib/logger";
import {
  getFilesystemPathModule,
  isAbsoluteFilesystemPath,
} from "@/lib/filesystem/host-path";
import { resolveSessionWorkspaceFilesystemRoot } from "@/lib/session/session-workspace-root";
import {
  isInsideWorkspacePath,
  resolveWorkspaceReadTarget,
} from "@/lib/workspace-files/workspace-file-read-target";
import {
  MAX_RAW_FILE_BYTES,
  MAX_TEXT_FILE_BYTES,
  WorkspaceFileError,
  withFsDeadline,
} from "@/lib/workspace-files/workspace-file-io";
import {
  createWorkspaceFile,
  saveWorkspaceFile,
} from "@/lib/workspace-files/workspace-file-write";
import {
  deleteWorkspaceEntry,
  renameWorkspaceEntry,
} from "@/lib/workspace-files/workspace-file-mutations";

async function resolveRequestedFile(root: string, rawPath: string): Promise<{
  absolutePath: string;
  relativePath: string;
}> {
  if (!rawPath.trim()) {
    throw new WorkspaceFileError("invalid_file_path", "Missing file path", 400);
  }
  if (rawPath.includes("\0")) {
    throw new WorkspaceFileError("invalid_file_path", "Invalid file path", 400);
  }

  const requestedPath = rawPath.replace(/\\/g, "/");
  if (isAbsoluteFilesystemPath(requestedPath)) {
    throw new WorkspaceFileError("invalid_file_path", "File path must be relative", 400);
  }
  const pathModule = getFilesystemPathModule(root);

  let rootRealPath: string;
  try {
    rootRealPath = await withFsDeadline(fs.realpath(root));
  } catch (error) {
    if (error instanceof WorkspaceFileError) throw error;
    throw new WorkspaceFileError("missing_work_dir", "Session working directory is unavailable", 422);
  }

  const candidatePath = pathModule.resolve(rootRealPath, requestedPath);
  if (!isInsideWorkspacePath(rootRealPath, candidatePath, pathModule)) {
    throw new WorkspaceFileError("invalid_file_path", "File path escapes the workspace", 400);
  }

  let absolutePath: string;
  try {
    absolutePath = await withFsDeadline(fs.realpath(candidatePath));
  } catch (error) {
    if (error instanceof WorkspaceFileError) throw error;
    throw new WorkspaceFileError("file_not_found", "File not found", 404);
  }

  const candidateIsSymlink = await withFsDeadline(fs.lstat(candidatePath))
    .then((stats) => stats.isSymbolicLink())
    .catch(() => false);
  const target = resolveWorkspaceReadTarget({
    candidatePath,
    candidateIsSymlink,
    pathModule,
    rootRealPath,
    targetRealPath: absolutePath,
  });
  if (!target.allowed) {
    throw new WorkspaceFileError("invalid_file_path", "File path escapes the workspace", 400);
  }

  return {
    absolutePath,
    relativePath: target.relativePath,
  };
}

function isLikelyBinary(buffer: Buffer): boolean {
  const sampleLength = Math.min(buffer.byteLength, 8000);
  for (let index = 0; index < sampleLength; index += 1) {
    if (buffer[index] === 0) return true;
  }
  return false;
}

function inferLanguage(filePath: string): string {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  const basename = path.basename(filePath).toLowerCase();
  if (basename === "dockerfile") return "dockerfile";
  if (basename === "makefile") return "makefile";
  const aliases: Record<string, string> = {
    cjs: "javascript",
    css: "css",
    go: "go",
    h: "c",
    hpp: "cpp",
    html: "html",
    js: "javascript",
    json: "json",
    jsx: "jsx",
    md: "markdown",
    mjs: "javascript",
    py: "python",
    rs: "rust",
    sh: "bash",
    sql: "sql",
    ts: "typescript",
    tsx: "tsx",
    txt: "text",
    yaml: "yaml",
    yml: "yaml",
  };
  return aliases[ext] ?? ext ?? "text";
}

function inferContentType(filePath: string): string {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  const aliases: Record<string, string> = {
    avif: "image/avif",
    bmp: "image/bmp",
    gif: "image/gif",
    jpeg: "image/jpeg",
    jpg: "image/jpeg",
    png: "image/png",
    svg: "image/svg+xml",
    webp: "image/webp",
  };
  return aliases[ext] ?? "application/octet-stream";
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;

  try {
    const resolved = await authenticateAndResolveRoot(request, id);
    if ("response" in resolved) return resolved.response;

    const rawPath = request.nextUrl.searchParams.get("path") ?? "";
    const { absolutePath, relativePath } = await resolveRequestedFile(resolved.root, rawPath);
    const fileStat = await withFsDeadline(fs.stat(absolutePath));
    if (!fileStat.isFile()) {
      throw new WorkspaceFileError("invalid_file_path", "Path is not a file", 400);
    }

    if (request.nextUrl.searchParams.get("raw") === "1") {
      if (fileStat.size > MAX_RAW_FILE_BYTES) {
        throw new WorkspaceFileError("file_too_large", "File is too large to preview", 413);
      }

      const buffer = await withFsDeadline(fs.readFile(absolutePath));
      return new NextResponse(buffer, {
        headers: {
          "Content-Type": inferContentType(relativePath),
          "Cache-Control": "private, max-age=30",
          "Content-Length": String(buffer.byteLength),
        },
      });
    }

    const readLength = Math.min(fileStat.size, MAX_TEXT_FILE_BYTES + 1);
    const handle = await withFsDeadline(fs.open(absolutePath, "r"));
    let buffer = Buffer.alloc(readLength);
    let bytesRead = 0;
    try {
      const result = await withFsDeadline(handle.read(buffer, 0, readLength, 0));
      bytesRead = result.bytesRead;
      buffer = buffer.subarray(0, bytesRead);
    } finally {
      // Do not tie the response to close(): it can hang on the same stalled
      // mounts the deadline above protects against.
      void handle.close().catch(() => {});
    }

    const binary = isLikelyBinary(buffer);
    const truncated = fileStat.size > MAX_TEXT_FILE_BYTES || bytesRead > MAX_TEXT_FILE_BYTES;
    const contentBuffer = buffer.subarray(0, Math.min(buffer.byteLength, MAX_TEXT_FILE_BYTES));

    return NextResponse.json({
      sessionId: id,
      workDir: resolved.root,
      path: relativePath,
      content: binary ? "" : contentBuffer.toString("utf8"),
      language: inferLanguage(relativePath),
      size: fileStat.size,
      mtimeMs: fileStat.mtimeMs,
      truncated,
      binary,
    });
  } catch (error) {
    return toErrorResponse(error, id, "load");
  }
}

function toErrorResponse(error: unknown, sessionId: string, action: string): NextResponse {
  if (error instanceof WorkspaceFileError) {
    return jsonError(error.code, error.message, error.status);
  }

  logger.error({ error, sessionId }, `Failed to ${action} workspace file`);
  return jsonError("internal_error", `Failed to ${action} workspace file`, 500);
}

interface WorkspaceWriteBody {
  path?: unknown;
  content?: unknown;
  baseMtimeMs?: unknown;
}

function parseWriteBody(body: unknown, options: { contentOptional?: boolean } = {}): {
  path: string;
  content: string;
  baseMtimeMs: number | null;
} {
  const { path: rawPath, content, baseMtimeMs } = (body ?? {}) as WorkspaceWriteBody;
  if (typeof rawPath !== "string") {
    throw new WorkspaceFileError("invalid_file_path", "Missing file path", 400);
  }
  if (typeof content !== "string" && !(options.contentOptional && content === undefined)) {
    throw new WorkspaceFileError("invalid_request", "Expected file content", 400);
  }
  return {
    path: rawPath,
    content: typeof content === "string" ? content : "",
    baseMtimeMs:
      typeof baseMtimeMs === "number" && Number.isFinite(baseMtimeMs) ? baseMtimeMs : null,
  };
}

async function authenticateAndResolveRoot(
  request: NextRequest,
  sessionId: string,
): Promise<{ root: string } | { response: NextResponse }> {
  const auth = await requireAuthenticatedUserId(request, {
    error: { code: "unauthorized", message: "Unauthorized" },
  });
  if ("response" in auth) return { response: auth.response };

  const root = await resolveSessionWorkspaceFilesystemRoot(sessionId);
  if (!root) {
    return { response: jsonError("missing_work_dir", "Session has no working directory", 422) };
  }
  return { root };
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;

  try {
    // Authenticate before reading the body: an unauthenticated caller should
    // not get as far as having its payload parsed.
    const resolved = await authenticateAndResolveRoot(request, id);
    if ("response" in resolved) return resolved.response;
    const body = parseWriteBody(await request.json().catch(() => null));

    const saved = await saveWorkspaceFile(resolved.root, {
      baseMtimeMs: body.baseMtimeMs,
      content: body.content,
      path: body.path,
    });

    return NextResponse.json({
      sessionId: id,
      path: saved.relativePath,
      size: saved.size,
      mtimeMs: saved.mtimeMs,
    });
  } catch (error) {
    return toErrorResponse(error, id, "save");
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;

  try {
    const resolved = await authenticateAndResolveRoot(request, id);
    if ("response" in resolved) return resolved.response;
    const body = parseWriteBody(await request.json().catch(() => null), { contentOptional: true });

    const created = await createWorkspaceFile(resolved.root, {
      content: body.content,
      path: body.path,
    });

    return NextResponse.json({
      sessionId: id,
      path: created.relativePath,
      size: created.size,
      mtimeMs: created.mtimeMs,
    });
  } catch (error) {
    return toErrorResponse(error, id, "create");
  }
}

function parseOptionalMtime(rawValue: string | null): number | null {
  if (rawValue === null) return null;
  const parsed = Number(rawValue);
  return Number.isFinite(parsed) ? parsed : null;
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;

  try {
    const resolved = await authenticateAndResolveRoot(request, id);
    if ("response" in resolved) return resolved.response;

    const searchParams = request.nextUrl.searchParams;
    const deleted = await deleteWorkspaceEntry(resolved.root, {
      baseMtimeMs: parseOptionalMtime(searchParams.get("baseMtimeMs")),
      path: searchParams.get("path") ?? "",
      recursive: searchParams.get("recursive") === "1",
    });

    return NextResponse.json({
      sessionId: id,
      path: deleted.relativePath,
      kind: deleted.kind,
      deleted: true,
    });
  } catch (error) {
    return toErrorResponse(error, id, "delete");
  }
}

interface WorkspaceRenameBody {
  path?: unknown;
  newName?: unknown;
  baseMtimeMs?: unknown;
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;

  try {
    const resolved = await authenticateAndResolveRoot(request, id);
    if ("response" in resolved) return resolved.response;

    const body = (await request.json().catch(() => null) ?? {}) as WorkspaceRenameBody;
    if (typeof body.path !== "string") {
      throw new WorkspaceFileError("invalid_file_path", "Missing file path", 400);
    }
    if (typeof body.newName !== "string") {
      throw new WorkspaceFileError("invalid_file_name", "Enter a name", 400);
    }

    const renamed = await renameWorkspaceEntry(resolved.root, {
      baseMtimeMs:
        typeof body.baseMtimeMs === "number" && Number.isFinite(body.baseMtimeMs)
          ? body.baseMtimeMs
          : null,
      newName: body.newName,
      path: body.path,
    });

    return NextResponse.json({
      sessionId: id,
      path: renamed.relativePath,
      previousPath: renamed.previousPath,
      kind: renamed.kind,
    });
  } catch (error) {
    return toErrorResponse(error, id, "rename");
  }
}
