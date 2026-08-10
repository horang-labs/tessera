import * as fs from "fs/promises";
import { getFilesystemPathModule } from "@/lib/filesystem/host-path";
import {
  MAX_TEXT_FILE_BYTES,
  WorkspaceFileError,
  isLikelyBinary,
  withFsDeadline,
} from "./workspace-file-io";
import {
  parseWorkspaceWritePath,
  resolveWorkspaceWriteTarget,
  type WorkspaceWritePathRejection,
} from "./workspace-file-write-target";

export interface WorkspaceWriteResult {
  relativePath: string;
  size: number;
  mtimeMs: number;
}

const PATH_REJECTION_MESSAGES: Record<WorkspaceWritePathRejection, string> = {
  absolute: "File path must be relative to the workspace",
  empty: "Missing file path",
  escapes: "File path escapes the workspace",
  invalid_base: "File path must name a file, not a directory",
  nul: "Invalid file path",
};

interface ResolvedWriteTarget {
  absolutePath: string;
  relativePath: string;
}

/**
 * Resolve where a write lands, for a path that may not exist yet.
 *
 * The read side realpaths the file itself and turns ENOENT into 404, which
 * cannot serve creation. Here the *parent* is realpathed and checked for
 * containment, then the basename is joined on — so a brand-new file resolves,
 * while a linked directory still cannot be used to leave the workspace.
 */
export async function resolveWorkspaceWriteTargetOnDisk(
  root: string,
  rawPath: string,
): Promise<ResolvedWriteTarget> {
  const parsed = parseWorkspaceWritePath(rawPath);
  if (!parsed.ok) {
    throw new WorkspaceFileError("invalid_file_path", PATH_REJECTION_MESSAGES[parsed.reason], 400);
  }

  const pathModule = getFilesystemPathModule(root);
  let rootRealPath: string;
  try {
    rootRealPath = await withFsDeadline(fs.realpath(root));
  } catch (error) {
    if (error instanceof WorkspaceFileError) throw error;
    throw new WorkspaceFileError("missing_work_dir", "Session working directory is unavailable", 422);
  }

  const candidatePath = pathModule.resolve(rootRealPath, parsed.normalizedPath);
  const parentPath = pathModule.dirname(candidatePath);
  const baseName = pathModule.basename(candidatePath);

  let parentRealPath: string;
  try {
    parentRealPath = await withFsDeadline(fs.realpath(parentPath));
  } catch (error) {
    if (error instanceof WorkspaceFileError) throw error;
    throw new WorkspaceFileError(
      "parent_not_found",
      "The folder for this file does not exist",
      404,
    );
  }

  const parentStat = await withFsDeadline(fs.stat(parentRealPath)).catch((error: unknown) => {
    if (error instanceof WorkspaceFileError) throw error;
    return null;
  });
  if (!parentStat?.isDirectory()) {
    throw new WorkspaceFileError("parent_not_found", "The folder for this file does not exist", 404);
  }

  const provisionalPath = pathModule.join(parentRealPath, baseName);
  const candidateStat = await withFsDeadline(fs.lstat(provisionalPath)).catch((error: unknown) => {
    if (error instanceof WorkspaceFileError) throw error;
    return null;
  });
  const candidateRealPath = candidateStat
    ? await withFsDeadline(fs.realpath(provisionalPath)).catch((error: unknown) => {
      if (error instanceof WorkspaceFileError) throw error;
      // A dangling link resolves nowhere; judge it by the link's own location.
      return provisionalPath;
    })
    : null;

  const target = resolveWorkspaceWriteTarget({
    baseName,
    candidateIsSymlink: candidateStat?.isSymbolicLink() ?? false,
    candidateRealPath,
    parentRealPath,
    pathModule,
    rootRealPath,
  });
  if (!target.allowed) {
    throw new WorkspaceFileError("invalid_file_path", "File path escapes the workspace", 400);
  }

  return { absolutePath: target.absolutePath, relativePath: target.relativePath };
}

function assertWritableSize(content: string): void {
  if (Buffer.byteLength(content, "utf8") > MAX_TEXT_FILE_BYTES) {
    throw new WorkspaceFileError("file_too_large", "File is too large to save", 413);
  }
}

async function statSaved(absolutePath: string, relativePath: string): Promise<WorkspaceWriteResult> {
  const savedStat = await withFsDeadline(fs.stat(absolutePath));
  return { relativePath, size: savedStat.size, mtimeMs: savedStat.mtimeMs };
}

/**
 * Refuse to replace anything the read route would not have handed over as a
 * whole text document.
 *
 * The editor already gates on `binary` and `truncated`, but that gate is in the
 * browser: without this the same PUT would happily replace a PNG with UTF-8, or
 * write back a buffer that only ever held the first 512 KB of a large file.
 */
async function assertReplaceableAsText(absolutePath: string, size: number): Promise<void> {
  if (size > MAX_TEXT_FILE_BYTES) {
    throw new WorkspaceFileError(
      "file_too_large",
      "This file is too large to edit, so it cannot be saved back",
      413,
    );
  }

  const handle = await withFsDeadline(fs.open(absolutePath, "r"));
  try {
    const sample = Buffer.alloc(Math.min(size, 8000));
    if (sample.byteLength === 0) return;
    const { bytesRead } = await withFsDeadline(handle.read(sample, 0, sample.byteLength, 0));
    if (isLikelyBinary(sample.subarray(0, bytesRead))) {
      throw new WorkspaceFileError("binary_file", "This file is binary and cannot be edited", 415);
    }
  } finally {
    // Not awaited: close() can hang on the same stalled mounts the deadline guards.
    void handle.close().catch(() => {});
  }
}

/**
 * Overwrite an existing workspace file.
 *
 * `baseMtimeMs` is the optimistic lock: it is the mtime the client loaded, and
 * a mismatch means the file changed underneath the editor, which is a 409 the
 * user resolves rather than a write we silently win.
 */
export async function saveWorkspaceFile(
  root: string,
  input: { path: string; content: string; baseMtimeMs?: number | null },
): Promise<WorkspaceWriteResult> {
  assertWritableSize(input.content);
  const { absolutePath, relativePath } = await resolveWorkspaceWriteTargetOnDisk(root, input.path);

  const currentStat = await withFsDeadline(fs.stat(absolutePath)).catch((error: unknown) => {
    if (error instanceof WorkspaceFileError) throw error;
    return null;
  });
  if (currentStat && !currentStat.isFile()) {
    throw new WorkspaceFileError("invalid_file_path", "Path is not a file", 400);
  }
  if (currentStat) {
    await assertReplaceableAsText(absolutePath, currentStat.size);
  }
  if (input.baseMtimeMs !== null && input.baseMtimeMs !== undefined) {
    if (!currentStat) {
      throw new WorkspaceFileError("conflict", "File was removed on disk", 409);
    }
    if (currentStat.mtimeMs !== input.baseMtimeMs) {
      throw new WorkspaceFileError("conflict", "File changed on disk", 409);
    }
  }

  await withFsDeadline(fs.writeFile(absolutePath, input.content, "utf8"));
  return statSaved(absolutePath, relativePath);
}

/**
 * Create a workspace file that must not exist yet. The `wx` flag makes the
 * existence check atomic, so two concurrent creates cannot both win.
 */
export async function createWorkspaceFile(
  root: string,
  input: { path: string; content?: string },
): Promise<WorkspaceWriteResult> {
  const content = input.content ?? "";
  assertWritableSize(content);
  const { absolutePath, relativePath } = await resolveWorkspaceWriteTargetOnDisk(root, input.path);

  try {
    await withFsDeadline(fs.writeFile(absolutePath, content, { encoding: "utf8", flag: "wx" }));
  } catch (error) {
    if (error instanceof WorkspaceFileError) throw error;
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new WorkspaceFileError("already_exists", "A file with this name already exists", 409);
    }
    throw error;
  }

  return statSaved(absolutePath, relativePath);
}
