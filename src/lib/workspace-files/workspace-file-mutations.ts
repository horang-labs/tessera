import * as fs from "fs/promises";
import { getFilesystemPathModule } from "@/lib/filesystem/host-path";
import { WorkspaceFileError, withFsDeadline } from "./workspace-file-io";
import { resolveWorkspaceWriteTargetOnDisk } from "./workspace-file-write";

export type WorkspaceEntryKind = "file" | "directory";

export type WorkspaceEntryNameRejection = "empty" | "nul" | "separator" | "dot_segment";

export type WorkspaceEntryNameParse =
  | { ok: false; reason: WorkspaceEntryNameRejection }
  | { ok: true; name: string };

/**
 * Validate the new name a rename lands on.
 *
 * Rename is same-directory only, so this takes a bare name and refuses
 * anything that would make it a move: a separator of either flavour (a Windows
 * workspace accepts both), and the dot segments that would name the directory
 * itself or its parent.
 */
export function parseWorkspaceEntryName(rawName: string): WorkspaceEntryNameParse {
  const name = rawName.trim();
  if (!name) return { ok: false, reason: "empty" };
  if (name.includes("\0")) return { ok: false, reason: "nul" };
  if (name.includes("/") || name.includes("\\")) return { ok: false, reason: "separator" };
  if (name === "." || name === "..") return { ok: false, reason: "dot_segment" };
  return { ok: true, name };
}

export interface WorkspaceDeleteResult {
  relativePath: string;
  kind: WorkspaceEntryKind;
}

/**
 * The optimistic lock shared by the mutating verbs, and the same one the save
 * route uses: `baseMtimeMs` is the mtime the caller last saw, so a mismatch
 * means the entry changed underneath and the destructive action is refused
 * rather than silently applied to something else.
 *
 * **The explorer does not send it.** The file list carries no mtime — only an
 * open tab has a baseline — so a delete or rename driven from a row passes
 * nothing here and the lock stays inert. It is honoured for callers that *do*
 * have a baseline, which is what makes the convention the same one across all
 * four verbs; nothing in the UI reaches it today.
 *
 * Followed, not lstat'd — the read route stats the resolved target, so a
 * symlink's baseline is its target's mtime and the two sides must agree.
 */
async function assertUnchangedSince(
  absolutePath: string,
  baseMtimeMs: number | null | undefined,
): Promise<void> {
  if (baseMtimeMs === null || baseMtimeMs === undefined) return;

  const current = await withFsDeadline(fs.stat(absolutePath)).catch((error: unknown) => {
    if (error instanceof WorkspaceFileError) throw error;
    return null;
  });
  if (!current) {
    throw new WorkspaceFileError("conflict", "File was removed on disk", 409);
  }
  if (current.mtimeMs !== baseMtimeMs) {
    throw new WorkspaceFileError("conflict", "File changed on disk", 409);
  }
}

/**
 * Remove a file or directory from the workspace, permanently.
 *
 * Resolution goes through the write-side resolver so the same containment and
 * symlink rules apply as to a save: the client-supplied path is never trusted,
 * and a path that only reaches its target through a linked directory is
 * refused rather than followed out of the workspace.
 */
export async function deleteWorkspaceEntry(
  root: string,
  input: { path: string; recursive?: boolean; baseMtimeMs?: number | null },
): Promise<WorkspaceDeleteResult> {
  const { absolutePath, relativePath } = await resolveWorkspaceWriteTargetOnDisk(root, input.path);

  // lstat, not stat: a symbolic link is deleted as the link it is, never
  // followed to whatever it points at.
  const stats = await withFsDeadline(fs.lstat(absolutePath)).catch((error: unknown) => {
    if (error instanceof WorkspaceFileError) throw error;
    return null;
  });
  if (!stats) {
    throw new WorkspaceFileError("file_not_found", "This file no longer exists", 404);
  }
  await assertUnchangedSince(absolutePath, input.baseMtimeMs);

  if (stats.isDirectory()) {
    if (input.recursive) {
      await withFsDeadline(fs.rm(absolutePath, { force: true, recursive: true }));
      return { relativePath, kind: "directory" };
    }
    // The explorer always asks to recurse for a folder, because its
    // confirmation has already said the contents go. This branch is the
    // guard for every other caller: without an explicit `recursive`, a
    // request cannot take a tree with it by accident.
    try {
      await withFsDeadline(fs.rmdir(absolutePath));
    } catch (error) {
      if (error instanceof WorkspaceFileError) throw error;
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOTEMPTY" || code === "EEXIST") {
        throw new WorkspaceFileError(
          "directory_not_empty",
          "This folder is not empty",
          409,
        );
      }
      throw error;
    }
    return { relativePath, kind: "directory" };
  }

  await withFsDeadline(fs.unlink(absolutePath));
  return { relativePath, kind: "file" };
}

const NAME_REJECTION_MESSAGES: Record<WorkspaceEntryNameRejection, string> = {
  dot_segment: "That name is not allowed",
  empty: "Enter a name",
  nul: "That name is not allowed",
  separator: "A name cannot contain a folder separator",
};

/**
 * Whether the rename target *is* the entry being renamed, under another casing.
 *
 * A case-insensitive filesystem — macOS and Windows both — reports the target
 * as already existing when the only difference is the casing of the entry
 * itself, and renaming `README.md` to `readme.md` is a rename a user is
 * entitled to make.
 *
 * Identity is decided by inode, never by resolved path: two distinct symlinks
 * pointing at one file resolve to the same path but are two entries, and
 * treating them as one would let the rename overwrite the second. The name
 * check keeps hard links out of it — those are two names for one inode, and
 * losing either is losing a row the user can see.
 */
async function isSameEntryUnderAnotherCase(
  sourcePath: string,
  sourceName: string,
  targetPath: string,
  targetName: string,
): Promise<boolean> {
  if (sourceName.toLowerCase() !== targetName.toLowerCase()) return false;

  try {
    const [source, target] = await Promise.all([
      withFsDeadline(fs.lstat(sourcePath)),
      withFsDeadline(fs.lstat(targetPath)),
    ]);
    return source.ino === target.ino && source.dev === target.dev;
  } catch {
    // Unreadable means a vanished entry; treat it as a genuine collision
    // rather than clearing the way for an overwrite.
    return false;
  }
}

export interface WorkspaceRenameResult {
  relativePath: string;
  previousPath: string;
  kind: WorkspaceEntryKind;
}

/**
 * Rename a file or folder in place.
 *
 * Same directory only: the caller supplies a name, not a path, so the move is
 * always a relabelling of an entry that stays where it is.
 */
export async function renameWorkspaceEntry(
  root: string,
  input: { path: string; newName: string; baseMtimeMs?: number | null },
): Promise<WorkspaceRenameResult> {
  const parsedName = parseWorkspaceEntryName(input.newName);
  if (!parsedName.ok) {
    throw new WorkspaceFileError(
      "invalid_file_name",
      NAME_REJECTION_MESSAGES[parsedName.reason],
      400,
    );
  }

  const { absolutePath, relativePath } = await resolveWorkspaceWriteTargetOnDisk(root, input.path);
  const stats = await withFsDeadline(fs.lstat(absolutePath)).catch((error: unknown) => {
    if (error instanceof WorkspaceFileError) throw error;
    return null;
  });
  if (!stats) {
    throw new WorkspaceFileError("file_not_found", "This file no longer exists", 404);
  }
  await assertUnchangedSince(absolutePath, input.baseMtimeMs);

  const pathModule = getFilesystemPathModule(root);
  const targetPath = pathModule.join(pathModule.dirname(absolutePath), parsedName.name);

  // fs.rename replaces an existing target without a word — on POSIX it is
  // defined to do exactly that — so the refusal has to be checked for. There is
  // no atomic alternative that covers directories, so this is a check-then-act
  // race the optimistic lock above narrows but cannot close.
  const existing = await withFsDeadline(fs.lstat(targetPath)).catch((error: unknown) => {
    if (error instanceof WorkspaceFileError) throw error;
    return null;
  });
  const sameEntry = existing !== null && await isSameEntryUnderAnotherCase(
    absolutePath,
    pathModule.basename(absolutePath),
    targetPath,
    parsedName.name,
  );
  if (existing && !sameEntry) {
    throw new WorkspaceFileError(
      "already_exists",
      "Something with this name already exists here",
      409,
    );
  }

  await withFsDeadline(fs.rename(absolutePath, targetPath));

  const parentRelative = relativePath.includes("/")
    ? relativePath.slice(0, relativePath.lastIndexOf("/"))
    : "";
  return {
    relativePath: parentRelative ? `${parentRelative}/${parsedName.name}` : parsedName.name,
    previousPath: relativePath,
    kind: stats.isDirectory() ? "directory" : "file",
  };
}

/**
 * Create one folder. Not `mkdir -p`: the parent has to exist, so a typo in the
 * middle of a path is a 404 rather than a surprise tree of empty folders, and
 * `EEXIST` is the 409 the duplicate-name refusal is built on — atomically,
 * unlike the rename above, because mkdir cannot be talked into replacing
 * anything.
 */
export async function createWorkspaceDirectory(
  root: string,
  input: { path: string },
): Promise<{ relativePath: string }> {
  const { absolutePath, relativePath } = await resolveWorkspaceWriteTargetOnDisk(root, input.path);

  try {
    await withFsDeadline(fs.mkdir(absolutePath));
  } catch (error) {
    if (error instanceof WorkspaceFileError) throw error;
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new WorkspaceFileError(
        "already_exists",
        "Something with this name already exists here",
        409,
      );
    }
    throw error;
  }

  return { relativePath };
}
