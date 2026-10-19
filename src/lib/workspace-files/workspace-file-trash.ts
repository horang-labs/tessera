import { execFile } from "node:child_process";
import * as fs from "fs/promises";
import os from "node:os";
import { WorkspaceFileError, withFsDeadline } from "./workspace-file-io";
import { resolveWorkspaceWriteTargetOnDisk } from "./workspace-file-write";

/**
 * Deleting to the OS trash, the way an editor does it — and only where the OS
 * has one for that path.
 *
 * A workspace on a WSL distro has none: the WSL volume has no Recycle Bin, so
 * from a Windows server (`\\wsl.localhost\...`) or from a server inside WSL
 * itself the only delete is a real one. Those paths report no trash and the UI
 * offers a permanent delete instead; nothing is ever parked in a folder of our
 * own for the user to discover and clean up later.
 */

export interface WorkspaceTrashSupport {
  /** What the OS calls it ("Recycle Bin", "Trash"), or null when this path has none. */
  label: string | null;
}

interface TrashEnvironment {
  platform: NodeJS.Platform;
  /** `os.release()`; a WSL kernel names Microsoft in it. */
  release: string;
  hasGio: boolean;
}

/** Pure decision, kept apart from the probes so it can be tested for every platform. */
export function resolveTrashSupport(root: string, environment: TrashEnvironment): WorkspaceTrashSupport {
  if (environment.platform === "win32") {
    // A drive letter is a local volume. A UNC path — including every
    // \\wsl.localhost\<distro>\ — has no Recycle Bin behind it.
    return { label: /^[A-Za-z]:[\\/]/.test(root) ? "Recycle Bin" : null };
  }
  if (environment.platform === "darwin") return { label: "Trash" };
  if (environment.platform === "linux") {
    if (/microsoft/i.test(environment.release)) return { label: null };
    return { label: environment.hasGio ? "Trash" : null };
  }
  return { label: null };
}

let gioProbe: Promise<boolean> | null = null;
function hasGio(): Promise<boolean> {
  gioProbe ??= new Promise((resolve) => {
    execFile("gio", ["version"], { timeout: 5_000 }, (error) => resolve(!error));
  });
  return gioProbe;
}

export async function getWorkspaceTrashSupport(root: string): Promise<WorkspaceTrashSupport> {
  const platform = process.platform;
  return resolveTrashSupport(root, {
    platform,
    release: os.release(),
    hasGio: platform === "linux" ? await hasGio() : false,
  });
}

const WINDOWS_RECYCLE_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$p = $env:TESSERA_TRASH_PATH",
  "Add-Type -AssemblyName Microsoft.VisualBasic",
  // A network or removable volume deletes for good instead of recycling; refuse.
  "if ([IO.DriveInfo]::new([IO.Path]::GetPathRoot($p)).DriveType -ne 'Fixed') { exit 3 }",
  "$fs = [Microsoft.VisualBasic.FileIO.FileSystem]",
  // One statement: `else` cannot follow a `;`.
  "if (Test-Path -LiteralPath $p -PathType Container) { $fs::DeleteDirectory($p, 'OnlyErrorDialogs', 'SendToRecycleBin') } else { $fs::DeleteFile($p, 'OnlyErrorDialogs', 'SendToRecycleBin') }",
].join("; ");

// NSFileManager rather than Finder: no Automation permission prompt.
const MACOS_TRASH_SCRIPT = [
  "ObjC.import('Foundation');",
  "function run(argv) {",
  "  const error = Ref();",
  "  const ok = $.NSFileManager.defaultManager.trashItemAtURLResultingItemURLError($.NSURL.fileURLWithPath(argv[0]), null, error);",
  "  if (!ok) throw new Error(ObjC.unwrap(error[0].localizedDescription));",
  "}",
].join("\n");

export interface TrashCommand {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export function buildTrashCommand(platform: NodeJS.Platform, absolutePath: string): TrashCommand | null {
  if (platform === "win32") {
    return {
      command: "powershell.exe",
      args: ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_RECYCLE_SCRIPT],
      env: { TESSERA_TRASH_PATH: absolutePath },
    };
  }
  if (platform === "darwin") {
    return { command: "osascript", args: ["-l", "JavaScript", "-e", MACOS_TRASH_SCRIPT, absolutePath] };
  }
  if (platform === "linux") return { command: "gio", args: ["trash", "--", absolutePath] };
  return null;
}

function run(command: TrashCommand): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      command.command,
      command.args,
      { timeout: 30_000, env: { ...process.env, ...command.env }, windowsHide: true },
      (error) => (error ? reject(error) : resolve()),
    );
  });
}

export interface WorkspaceTrashResult {
  relativePath: string;
  kind: "file" | "directory";
}

/**
 * Send a file or folder to the OS trash. Containment and symlink rules are the
 * same as every other mutation: the client's path is resolved on disk first.
 * Where the OS has no trash for the path nothing is touched and
 * `trash_unavailable` tells the caller to offer a permanent delete.
 */
export async function trashWorkspaceEntry(
  root: string,
  input: { path: string },
): Promise<WorkspaceTrashResult> {
  const { absolutePath, relativePath } = await resolveWorkspaceWriteTargetOnDisk(root, input.path);
  const stats = await withFsDeadline(fs.lstat(absolutePath)).catch((error: unknown) => {
    if (error instanceof WorkspaceFileError) throw error;
    return null;
  });
  if (!stats) {
    throw new WorkspaceFileError("file_not_found", "This file no longer exists", 404);
  }

  const support = await getWorkspaceTrashSupport(root);
  const command = support.label ? buildTrashCommand(process.platform, absolutePath) : null;
  if (!support.label || !command) {
    throw new WorkspaceFileError(
      "trash_unavailable",
      "This workspace has no Trash. Delete it permanently instead.",
      409,
    );
  }

  try {
    await run(command);
  } catch {
    throw new WorkspaceFileError(
      "trash_unavailable",
      `Could not move this to the ${support.label}. Delete it permanently instead.`,
      409,
    );
  }
  return { relativePath, kind: stats.isDirectory() ? "directory" : "file" };
}
