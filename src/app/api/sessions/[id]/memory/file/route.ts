import { NextRequest, NextResponse } from "next/server";
import * as fs from "fs/promises";
import { requireAuthenticatedUserId } from "@/lib/auth/api-auth";
import { getAgentEnvironment } from "@/lib/cli/spawn-cli";
import * as dbSessions from "@/lib/db/sessions";
import { jsonError } from "@/lib/http/json-error";
import logger from "@/lib/logger";
import {
  resolveCodexGuidelineTarget,
  resolveCodexMemoryContext,
  resolveCodexMemoryFilePath,
} from "@/lib/memory/codex-memory";
import {
  resolveOpenCodeGuidelineTarget,
} from "@/lib/memory/opencode-memory";
import {
  MAX_MEMORY_FILE_BYTES,
  MemoryApiError,
  parseMemoryRootKey,
  resolveGuidelineTarget,
  resolveMemoryFilePath,
  resolveSessionMemoryDir,
  withFsDeadline,
} from "@/lib/memory/claude-memory";
import { getMemoryProviderKind } from "@/lib/memory/memory-provider";
import type { CliEnvironment } from "@/lib/cli/cli-exec";
import type { MemoryFileData, MemoryProviderKind, MemoryRootKey, MemoryTargetKind } from "@/types/memory";

interface ResolvedTarget {
  provider: MemoryProviderKind;
  kind: MemoryTargetKind;
  absolutePath: string;
  /** Folder the target lives in (memory dir or CLAUDE.md's folder). */
  dir: string;
  /** Display file name. */
  fileName: string;
  relativePath: string;
  root: MemoryRootKey;
  readOnly: boolean;
}

function parseTargetKind(value: unknown): MemoryTargetKind {
  return value === "global-guideline" || value === "project-guideline" ? value : "memory";
}

/**
 * Resolve where a request points, by kind. Memory targets validate the file
 * name inside the memory dir; guideline targets are fixed CLAUDE.md paths
 * (no client-supplied name, so no traversal surface).
 */
async function resolveTarget(
  sessionId: string,
  environment: CliEnvironment,
  kind: MemoryTargetKind,
  name: string,
  pinnedRoot: MemoryRootKey | null,
): Promise<ResolvedTarget> {
  const session = dbSessions.getSession(sessionId);
  const provider = getMemoryProviderKind(session?.provider);
  if (!provider) {
    throw new MemoryApiError("unsupported_provider", "Memory is not available for this provider", 400);
  }

  if (provider === "codex") {
    if (kind === "memory") {
      const context = await resolveCodexMemoryContext(sessionId, environment);
      if (!context) {
        throw new MemoryApiError("missing_work_dir", "Session has no working directory", 422);
      }
      const { fileName, relativePath, absolutePath } = resolveCodexMemoryFilePath(context.memoryDir, name);
      return {
        provider,
        kind,
        absolutePath,
        dir: context.memoryDir,
        fileName,
        relativePath,
        root: "project",
        readOnly: true,
      };
    }

    const target = await resolveCodexGuidelineTarget(sessionId, environment, kind, name);
    return {
      provider,
      kind,
      absolutePath: target.absolutePath,
      dir: target.dir,
      fileName: target.fileName,
      relativePath: target.fileName,
      root: "project",
      readOnly: false,
    };
  }

  if (provider === "opencode") {
    if (kind === "memory") {
      throw new MemoryApiError("unsupported_provider_memory", "OpenCode does not have built-in memory files", 400);
    }

    const target = await resolveOpenCodeGuidelineTarget(sessionId, environment, kind, name);
    return {
      provider,
      kind,
      absolutePath: target.absolutePath,
      dir: target.dir,
      fileName: target.fileName,
      relativePath: target.fileName,
      root: "project",
      readOnly: false,
    };
  }

  if (kind === "memory") {
    const context = await resolveSessionMemoryDir(sessionId, environment, pinnedRoot);
    if (!context) {
      throw new MemoryApiError("missing_work_dir", "Session has no working directory", 422);
    }
    const { fileName, absolutePath } = resolveMemoryFilePath(context.memoryDir, name);
    return {
      provider,
      kind,
      absolutePath,
      dir: context.memoryDir,
      fileName,
      relativePath: fileName,
      root: context.root,
      readOnly: false,
    };
  }

  const target = await resolveGuidelineTarget(sessionId, environment, kind);
  return {
    provider,
    kind,
    absolutePath: target.absolutePath,
    dir: target.dir,
    fileName: "CLAUDE.md",
    relativePath: "CLAUDE.md",
    root: "workDir",
    readOnly: false,
  };
}

async function authenticateAndResolveEnv(
  request: NextRequest,
): Promise<{ userId: string; environment: CliEnvironment } | { response: NextResponse }> {
  const auth = await requireAuthenticatedUserId(request, {
    error: { code: "unauthorized", message: "Unauthorized" },
  });
  if ("response" in auth) return auth;
  const environment = await getAgentEnvironment(auth.userId);
  return { userId: auth.userId, environment };
}

interface MemoryWriteBody {
  kind?: unknown;
  name?: unknown;
  content?: unknown;
  baseMtimeMs?: unknown;
  root?: unknown;
}

function parseWriteBody(body: unknown): {
  kind: MemoryTargetKind;
  name: string;
  content: string;
  baseMtimeMs: number | null;
  root: MemoryRootKey | null;
} {
  const { kind, name, content, baseMtimeMs, root } = (body ?? {}) as MemoryWriteBody;
  const targetKind = parseTargetKind(kind);
  if (typeof content !== "string") {
    throw new MemoryApiError("invalid_request", "Expected file content", 400);
  }
  if (targetKind === "memory" && typeof name !== "string") {
    throw new MemoryApiError("invalid_request", "Expected a memory file name", 400);
  }
  if (Buffer.byteLength(content, "utf8") > MAX_MEMORY_FILE_BYTES) {
    throw new MemoryApiError("file_too_large", "File is too large to save", 413);
  }
  return {
    kind: targetKind,
    name: typeof name === "string" ? name : "",
    content,
    baseMtimeMs: typeof baseMtimeMs === "number" && Number.isFinite(baseMtimeMs) ? baseMtimeMs : null,
    root: parseMemoryRootKey(root),
  };
}

function toErrorResponse(error: unknown, sessionId: string, action: string): NextResponse {
  if (error instanceof MemoryApiError) {
    return jsonError(error.code, error.message, error.status);
  }
  logger.error({ error, sessionId }, `Failed to ${action} memory file`);
  return jsonError("internal_error", `Failed to ${action} memory file`, 500);
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;

  try {
    const resolved = await authenticateAndResolveEnv(request);
    if ("response" in resolved) return resolved.response;

    const kind = parseTargetKind(request.nextUrl.searchParams.get("kind"));
    const target = await resolveTarget(
      id,
      resolved.environment,
      kind,
      request.nextUrl.searchParams.get("name") ?? "",
      parseMemoryRootKey(request.nextUrl.searchParams.get("root")),
    );

    let fileStat;
    try {
      fileStat = await withFsDeadline(fs.stat(target.absolutePath));
    } catch (error) {
      if (error instanceof MemoryApiError) throw error;
      // A guideline file (e.g. project CLAUDE.md) may not exist yet: return an
      // empty, editable document instead of 404 so the user can create it.
      if (kind !== "memory") {
        return NextResponse.json(emptyFileData(id, target));
      }
      throw new MemoryApiError("file_not_found", "Memory file not found", 404);
    }
    if (!fileStat.isFile()) {
      throw new MemoryApiError("invalid_target", "Path is not a file", 400);
    }
    if (fileStat.size > MAX_MEMORY_FILE_BYTES) {
      throw new MemoryApiError("file_too_large", "File is too large to open", 413);
    }

    const content = await withFsDeadline(fs.readFile(target.absolutePath, "utf8"));
    const payload: MemoryFileData = {
      sessionId: id,
      provider: target.provider,
      kind: target.kind,
      dir: target.dir,
      root: target.root,
      fileName: target.fileName,
      relativePath: target.relativePath,
      content,
      size: fileStat.size,
      mtimeMs: fileStat.mtimeMs,
      readOnly: target.readOnly,
    };
    return NextResponse.json(payload);
  } catch (error) {
    return toErrorResponse(error, id, "load");
  }
}

function emptyFileData(sessionId: string, target: ResolvedTarget): MemoryFileData {
  return {
    sessionId,
    provider: target.provider,
    kind: target.kind,
    dir: target.dir,
    root: target.root,
    fileName: target.fileName,
    relativePath: target.relativePath,
    content: "",
    size: 0,
    mtimeMs: 0,
    readOnly: target.readOnly,
  };
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;

  try {
    const body = parseWriteBody(await request.json().catch(() => null));
    const resolved = await authenticateAndResolveEnv(request);
    if ("response" in resolved) return resolved.response;

    const target = await resolveTarget(id, resolved.environment, body.kind, body.name, body.root);
    if (target.readOnly) {
      throw new MemoryApiError("read_only_memory_file", "This memory file is read-only", 403);
    }

    if (body.baseMtimeMs !== null) {
      let currentStat;
      try {
        currentStat = await withFsDeadline(fs.stat(target.absolutePath));
      } catch (error) {
        if (error instanceof MemoryApiError) throw error;
        // baseMtimeMs 0 means "expected to not exist yet" (a fresh guideline);
        // only treat a vanished file as a conflict when we expected content.
        if (body.baseMtimeMs === 0) currentStat = null;
        else throw new MemoryApiError("conflict", "File was removed on disk", 409);
      }
      if (currentStat && currentStat.mtimeMs !== body.baseMtimeMs) {
        throw new MemoryApiError("conflict", "File changed on disk", 409);
      }
    }

    await withFsDeadline(fs.mkdir(target.dir, { recursive: true }));
    await withFsDeadline(fs.writeFile(target.absolutePath, body.content, "utf8"));
    const savedStat = await withFsDeadline(fs.stat(target.absolutePath));

    return NextResponse.json({
      sessionId: id,
      kind: target.kind,
      fileName: target.fileName,
      relativePath: target.relativePath,
      size: savedStat.size,
      mtimeMs: savedStat.mtimeMs,
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
    const body = parseWriteBody(await request.json().catch(() => null));
    // Creating a brand-new file only applies to memory entries; CLAUDE.md
    // guidelines are edited (and created if missing) through PUT.
    if (body.kind !== "memory") {
      throw new MemoryApiError("invalid_request", "Only memory files can be created", 400);
    }
    const resolved = await authenticateAndResolveEnv(request);
    if ("response" in resolved) return resolved.response;

    const target = await resolveTarget(id, resolved.environment, "memory", body.name, body.root);
    if (target.readOnly) {
      throw new MemoryApiError("read_only_memory_file", "This memory file is read-only", 403);
    }

    await withFsDeadline(fs.mkdir(target.dir, { recursive: true }));
    try {
      // "wx" fails when the file already exists, making the existence check atomic.
      await withFsDeadline(fs.writeFile(target.absolutePath, body.content, { encoding: "utf8", flag: "wx" }));
    } catch (error) {
      if (error instanceof MemoryApiError) throw error;
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new MemoryApiError("already_exists", "A memory file with this name already exists", 409);
      }
      throw error;
    }
    const savedStat = await withFsDeadline(fs.stat(target.absolutePath));

    return NextResponse.json({
      sessionId: id,
      kind: target.kind,
      fileName: target.fileName,
      relativePath: target.relativePath,
      size: savedStat.size,
      mtimeMs: savedStat.mtimeMs,
    });
  } catch (error) {
    return toErrorResponse(error, id, "create");
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;

  try {
    const kind = parseTargetKind(request.nextUrl.searchParams.get("kind"));
    // Deleting a CLAUDE.md through this UI would be surprising and destructive;
    // only memory entries can be deleted.
    if (kind !== "memory") {
      throw new MemoryApiError("invalid_request", "Only memory files can be deleted", 400);
    }
    const resolved = await authenticateAndResolveEnv(request);
    if ("response" in resolved) return resolved.response;

    const target = await resolveTarget(
      id,
      resolved.environment,
      "memory",
      request.nextUrl.searchParams.get("name") ?? "",
      parseMemoryRootKey(request.nextUrl.searchParams.get("root")),
    );
    if (target.readOnly) {
      throw new MemoryApiError("read_only_memory_file", "This memory file is read-only", 403);
    }

    try {
      await withFsDeadline(fs.unlink(target.absolutePath));
    } catch (error) {
      if (error instanceof MemoryApiError) throw error;
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new MemoryApiError("file_not_found", "Memory file not found", 404);
      }
      throw error;
    }

    return NextResponse.json({ sessionId: id, fileName: target.fileName, relativePath: target.relativePath, deleted: true });
  } catch (error) {
    return toErrorResponse(error, id, "delete");
  }
}
