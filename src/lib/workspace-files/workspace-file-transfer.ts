import * as fs from "fs/promises";
import { MAX_RAW_FILE_BYTES, WorkspaceFileError, withFsDeadline } from "./workspace-file-io";
import { resolveWorkspaceWriteTargetOnDisk } from "./workspace-file-write";

export type WorkspaceTransferOperation = "move" | "copy";

export interface WorkspaceTransferResult {
  operation: WorkspaceTransferOperation;
  entries: Array<{ from: string; to: string; kind: "file" | "directory" }>;
}

/** Copying a tree is slower than the 2 s metadata deadline allows for. */
const COPY_TIMEOUT_MS = 60_000;

function withCopyDeadline<T>(operation: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new WorkspaceFileError(
        "filesystem_timeout",
        "The workspace filesystem did not respond in time",
        504,
      ));
    }, COPY_TIMEOUT_MS);
    operation.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

function joinRelative(directory: string, name: string): string {
  return directory ? `${directory}/${name}` : name;
}

function baseNameOf(relativePath: string): string {
  return relativePath.slice(relativePath.lastIndexOf("/") + 1);
}

function parentOf(relativePath: string): string {
  const index = relativePath.lastIndexOf("/");
  return index === -1 ? "" : relativePath.slice(0, index);
}

function normalizeDirectory(raw: string): string {
  return raw.replace(/\\/g, "/").split("/").filter((segment) => segment && segment !== ".").join("/");
}

async function lstatOrNull(absolutePath: string) {
  return withFsDeadline(fs.lstat(absolutePath)).catch((error: unknown) => {
    if (error instanceof WorkspaceFileError) throw error;
    return null;
  });
}

/** `name copy.ext`, `name copy 2.ext`, ... — the first one not taken. */
async function pickCopyName(root: string, directory: string, name: string, isDirectory: boolean): Promise<string> {
  const dot = isDirectory ? -1 : name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const extension = dot > 0 ? name.slice(dot) : "";
  for (let attempt = 1; attempt < 1000; attempt += 1) {
    const suffix = attempt === 1 ? " copy" : ` copy ${attempt}`;
    const candidate = `${stem}${suffix}${extension}`;
    const target = await resolveWorkspaceWriteTargetOnDisk(root, joinRelative(directory, candidate));
    if (!(await lstatOrNull(target.absolutePath))) return candidate;
  }
  throw new WorkspaceFileError("already_exists", "Could not find a free name for the copy", 409);
}

/**
 * Move or copy workspace entries into one destination folder.
 *
 * Every path goes through the write-side resolver, so containment and symlink
 * rules match a save. A move never overwrites: a clash is a 409 and nothing
 * after it runs. A copy that would clash gets a free "copy" name instead, which
 * is also what makes duplicating in place work.
 */
export async function transferWorkspaceEntries(
  root: string,
  input: { operation: WorkspaceTransferOperation; sources: readonly string[]; destination: string },
): Promise<WorkspaceTransferResult> {
  const destination = normalizeDirectory(input.destination);
  if (input.sources.length === 0) {
    throw new WorkspaceFileError("invalid_request", "Nothing to transfer", 400);
  }

  if (destination) {
    const destinationTarget = await resolveWorkspaceWriteTargetOnDisk(root, destination);
    const destinationStat = await lstatOrNull(destinationTarget.absolutePath);
    const real = destinationStat ? await withFsDeadline(fs.stat(destinationTarget.absolutePath)).catch(() => null) : null;
    if (!real?.isDirectory()) {
      throw new WorkspaceFileError("parent_not_found", "The destination folder does not exist", 404);
    }
  }

  const entries: WorkspaceTransferResult["entries"] = [];

  for (const rawSource of input.sources) {
    const source = await resolveWorkspaceWriteTargetOnDisk(root, rawSource);
    const stats = await lstatOrNull(source.absolutePath);
    if (!stats) {
      throw new WorkspaceFileError("file_not_found", "This file no longer exists", 404);
    }
    const isDirectory = stats.isDirectory();
    const name = baseNameOf(source.relativePath);

    if (isDirectory && (destination === source.relativePath || destination.startsWith(`${source.relativePath}/`))) {
      throw new WorkspaceFileError("invalid_destination", "A folder cannot be moved into itself", 400);
    }

    const inPlace = parentOf(source.relativePath) === destination;
    if (input.operation === "move" && inPlace) {
      entries.push({ from: source.relativePath, to: source.relativePath, kind: isDirectory ? "directory" : "file" });
      continue;
    }

    const targetName = input.operation === "copy"
      ? await pickCopyName(root, destination, name, isDirectory).then(async (copyName) => {
        const plain = await resolveWorkspaceWriteTargetOnDisk(root, joinRelative(destination, name));
        return (await lstatOrNull(plain.absolutePath)) ? copyName : name;
      })
      : name;
    const target = await resolveWorkspaceWriteTargetOnDisk(root, joinRelative(destination, targetName));

    if (input.operation === "move") {
      if (await lstatOrNull(target.absolutePath)) {
        throw new WorkspaceFileError("already_exists", `"${name}" already exists in the destination`, 409);
      }
      try {
        await withFsDeadline(fs.rename(source.absolutePath, target.absolutePath));
      } catch (error) {
        if (error instanceof WorkspaceFileError) throw error;
        if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
        await withCopyDeadline(fs.cp(source.absolutePath, target.absolutePath, {
          recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true,
        }));
        await withCopyDeadline(fs.rm(source.absolutePath, { recursive: true, force: true }));
      }
    } else {
      await withCopyDeadline(fs.cp(source.absolutePath, target.absolutePath, {
        recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true,
      }));
    }
    entries.push({ from: source.relativePath, to: target.relativePath, kind: isDirectory ? "directory" : "file" });
  }

  return { operation: input.operation, entries };
}

export interface WorkspaceUploadItem {
  /** Path relative to the destination folder; may include sub-folders. */
  relativePath: string;
  data: Buffer;
}

/**
 * Write files dropped in from outside the app. Missing intermediate folders are
 * created one level at a time through the resolver; an existing file is a 409
 * rather than being overwritten.
 */
export async function uploadWorkspaceFiles(
  root: string,
  input: { destination: string; items: readonly WorkspaceUploadItem[] },
): Promise<{ paths: string[] }> {
  const destination = normalizeDirectory(input.destination);
  const written: string[] = [];

  for (const item of input.items) {
    if (item.data.byteLength > MAX_RAW_FILE_BYTES) {
      throw new WorkspaceFileError("file_too_large", "File is too large to upload", 413);
    }
    const segments = item.relativePath.replace(/\\/g, "/").split("/").filter((segment) => segment && segment !== ".");
    if (segments.length === 0 || segments.includes("..")) {
      throw new WorkspaceFileError("invalid_file_path", "Invalid file path", 400);
    }

    let directory = destination;
    for (const segment of segments.slice(0, -1)) {
      directory = joinRelative(directory, segment);
      const folder = await resolveWorkspaceWriteTargetOnDisk(root, directory);
      try {
        await withFsDeadline(fs.mkdir(folder.absolutePath));
      } catch (error) {
        if (error instanceof WorkspaceFileError) throw error;
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }

    const target = await resolveWorkspaceWriteTargetOnDisk(root, joinRelative(directory, segments[segments.length - 1]));
    try {
      await withCopyDeadline(fs.writeFile(target.absolutePath, item.data, { flag: "wx" }));
    } catch (error) {
      if (error instanceof WorkspaceFileError) throw error;
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new WorkspaceFileError("already_exists", `"${target.relativePath}" already exists`, 409);
      }
      throw error;
    }
    written.push(target.relativePath);
  }

  return { paths: written };
}
