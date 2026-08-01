import type * as path from "path";

type PathModule = typeof path.win32 | typeof path.posix;

export function isInsideWorkspacePath(
  root: string,
  candidate: string,
  pathModule: PathModule,
): boolean {
  const relative = pathModule.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !pathModule.isAbsolute(relative));
}

export interface WorkspaceReadTargetInput {
  /** Where the requested path lands lexically inside the workspace. */
  candidatePath: string;
  /** Whether `candidatePath` is itself a symbolic link (lstat, not stat). */
  candidateIsSymlink: boolean;
  pathModule: PathModule;
  /** The workspace root, already resolved through realpath. */
  rootRealPath: string;
  /** `candidatePath` resolved through realpath — where the bytes actually live. */
  targetRealPath: string;
}

export type WorkspaceReadTarget =
  | { allowed: false }
  | { allowed: true; relativePath: string };

/**
 * Decide whether a resolved file may be read, and under which workspace-relative
 * path it should be reported.
 *
 * The caller has already rejected paths that escape lexically (`../`, absolute).
 * What is left is the symlink case: a link the user placed *inside* the
 * workspace whose target lives outside it. Worktree bootstrap scripts create
 * exactly that (`ln -s "$TESSERA_PROJECT_DIR/CLAUDE.md"`), and the file tree
 * lists those links, so refusing to open them leaves a visible-but-dead row.
 *
 * Exactly one link is followed: `candidatePath` itself must be the link. A path
 * that only reaches outside through an intermediate linked directory stays
 * blocked, which matches what the workspace scan is willing to index.
 */
export function resolveWorkspaceReadTarget(
  input: WorkspaceReadTargetInput,
): WorkspaceReadTarget {
  const { candidatePath, candidateIsSymlink, pathModule, rootRealPath, targetRealPath } = input;

  const insideWorkspace = isInsideWorkspacePath(rootRealPath, targetRealPath, pathModule);
  if (!insideWorkspace && !candidateIsSymlink) {
    return { allowed: false };
  }

  // A followed link is reported under the path that was clicked, not the
  // target's own location: the target can sit anywhere, and relative() would
  // hand the UI a "../../…" string it cannot use as a workspace path.
  const reportedPath = insideWorkspace ? targetRealPath : candidatePath;
  return {
    allowed: true,
    relativePath: pathModule.relative(rootRealPath, reportedPath).split(/[\\/]+/).join("/"),
  };
}
