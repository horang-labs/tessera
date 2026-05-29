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

const MAX_TEXT_FILE_BYTES = 512 * 1024;
const MAX_RAW_FILE_BYTES = 25 * 1024 * 1024;

class WorkspaceFileError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

type PathModule = typeof path.win32 | typeof path.posix;

function isInsidePath(root: string, candidate: string, pathModule: PathModule): boolean {
  const relative = pathModule.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !pathModule.isAbsolute(relative));
}

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
    rootRealPath = await fs.realpath(root);
  } catch {
    throw new WorkspaceFileError("missing_work_dir", "Session working directory is unavailable", 422);
  }

  const candidatePath = pathModule.resolve(rootRealPath, requestedPath);
  if (!isInsidePath(rootRealPath, candidatePath, pathModule)) {
    throw new WorkspaceFileError("invalid_file_path", "File path escapes the workspace", 400);
  }

  let absolutePath: string;
  try {
    absolutePath = await fs.realpath(candidatePath);
  } catch {
    throw new WorkspaceFileError("file_not_found", "File not found", 404);
  }

  if (!isInsidePath(rootRealPath, absolutePath, pathModule)) {
    throw new WorkspaceFileError("invalid_file_path", "File path escapes the workspace", 400);
  }

  return {
    absolutePath,
    relativePath: pathModule.relative(rootRealPath, absolutePath).split(/[\\/]+/).join("/"),
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
    const auth = await requireAuthenticatedUserId(request, {
      error: { code: "unauthorized", message: "Unauthorized" },
    });
    if ("response" in auth) return auth.response;

    const root = await resolveSessionWorkspaceFilesystemRoot(id);
    if (!root) {
      return jsonError("missing_work_dir", "Session has no working directory", 422);
    }

    const rawPath = request.nextUrl.searchParams.get("path") ?? "";
    const { absolutePath, relativePath } = await resolveRequestedFile(root, rawPath);
    const fileStat = await fs.stat(absolutePath);
    if (!fileStat.isFile()) {
      throw new WorkspaceFileError("invalid_file_path", "Path is not a file", 400);
    }

    if (request.nextUrl.searchParams.get("raw") === "1") {
      if (fileStat.size > MAX_RAW_FILE_BYTES) {
        throw new WorkspaceFileError("file_too_large", "File is too large to preview", 413);
      }

      const buffer = await fs.readFile(absolutePath);
      return new NextResponse(buffer, {
        headers: {
          "Content-Type": inferContentType(relativePath),
          "Cache-Control": "private, max-age=30",
          "Content-Length": String(buffer.byteLength),
        },
      });
    }

    const readLength = Math.min(fileStat.size, MAX_TEXT_FILE_BYTES + 1);
    const handle = await fs.open(absolutePath, "r");
    let buffer = Buffer.alloc(readLength);
    let bytesRead = 0;
    try {
      const result = await handle.read(buffer, 0, readLength, 0);
      bytesRead = result.bytesRead;
      buffer = buffer.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }

    const binary = isLikelyBinary(buffer);
    const truncated = fileStat.size > MAX_TEXT_FILE_BYTES || bytesRead > MAX_TEXT_FILE_BYTES;
    const contentBuffer = buffer.subarray(0, Math.min(buffer.byteLength, MAX_TEXT_FILE_BYTES));

    return NextResponse.json({
      sessionId: id,
      workDir: root,
      path: relativePath,
      content: binary ? "" : contentBuffer.toString("utf8"),
      language: inferLanguage(relativePath),
      size: fileStat.size,
      truncated,
      binary,
    });
  } catch (error) {
    if (error instanceof WorkspaceFileError) {
      return jsonError(error.code, error.message, error.status);
    }

    logger.error({ error, sessionId: id }, "Failed to load workspace file");
    return jsonError("internal_error", "Failed to load workspace file", 500);
  }
}
