/**
 * Whether a worktree is stopped in the middle of a merge, a rebase or a
 * cherry-pick (`docs/design/git-delivery.md` §9).
 *
 * A filesystem probe rather than another Git command, which is the whole point:
 * the panel reads this on every refresh, and §9 requires the answer to cost no
 * Git invocation. What it looks at is what Git itself looks at — the marker
 * files it writes into the git directory when an operation stops — so the answer
 * is Git's own rather than an inference from `git status`.
 */
import { readFile, stat } from "fs/promises";
import {
  getFilesystemPathModule,
  isAbsoluteFilesystemPath,
} from "@/lib/filesystem/host-path";
import { resolveAgentReportedPath } from "@/lib/filesystem/path-environment";
import logger from "@/lib/logger";
import type { AgentEnvironment } from "@/lib/settings/types";
import type { GitConflictOperation } from "@/types/git";

/**
 * `worktreePath` is a path Git reported, so it names a file in the environment
 * the CLI runs in — which on a bridged setup this process cannot open. It is
 * translated through `resolveAgentReportedPath`, which CLAUDE.md names as the
 * helper for exactly this and which is a no-op on the setups that share one
 * filesystem. `agentEnvironment` is the authority for which side that is (ADR
 * 0006); inferring it from the shape of the path would be a second source of
 * truth for a fact the setting already fixes.
 *
 * Null means "nothing in progress", and it is also what an unreadable git
 * directory answers. Failing open is deliberate: the cost of missing a conflict
 * is a commit that Git refuses with its own message, while the cost of guessing
 * one is a worktree whose commit path is blocked with no way to unblock it.
 */
export async function detectGitConflictOperation(
  worktreePath: string,
  agentEnvironment: AgentEnvironment,
): Promise<GitConflictOperation | null> {
  try {
    const gitDir = await resolveWorktreeGitDir(
      await resolveAgentReportedPath(worktreePath, agentEnvironment),
      agentEnvironment,
    );
    const pathModule = getFilesystemPathModule(gitDir);
    const [merge, rebaseMerge, rebaseApply, cherryPick] = await Promise.all([
      exists(pathModule.join(gitDir, "MERGE_HEAD")),
      exists(pathModule.join(gitDir, "rebase-merge")),
      exists(pathModule.join(gitDir, "rebase-apply")),
      exists(pathModule.join(gitDir, "CHERRY_PICK_HEAD")),
    ]);

    // Rebase is read from its directories rather than from `REBASE_HEAD`, which
    // Git leaves behind after the rebase is over and which would keep a worktree
    // with nothing in progress blocked forever.
    //
    // The three are disjoint on the plain operations, so the order only decides
    // what happens if a Git version ever writes two at once. Rebase wins because
    // it is the only one of the three that owns the sequencer: a worktree with a
    // rebase directory is put back by `git rebase --abort` and by nothing else,
    // whichever other marker sits beside it.
    if (rebaseMerge || rebaseApply) return "rebase";
    if (cherryPick) return "cherry_pick";
    if (merge) return "merge";
    return null;
  } catch (error) {
    // Still null — the panel must render whatever went wrong here. But only a
    // filesystem answering "no" is ordinary; anything else is this module being
    // broken, and a silent fail-open would hide that behind a worktree that
    // simply never reports a conflict.
    if (!isExpectedProbeError(error)) {
      logger.warn(
        { error, worktreePath },
        "Failed to probe for an unfinished git operation",
      );
    }
    return null;
  }
}

/** A path that is not there, or not ours to read. Both mean "no conflict". */
function isExpectedProbeError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return (
    code === "ENOENT"
    || code === "ENOTDIR"
    || code === "EACCES"
    || code === "EPERM"
    // What a Windows host answers for an unreachable UNC path — a distro that
    // is not running, which is not a broken probe.
    || code === "ENETUNREACH"
  );
}

/**
 * Where this worktree's own operation state lives, as a path *this process* can
 * open. A linked worktree — which is what most Tessera sessions run in — has
 * `.git` as a *file* naming a directory under the main repository's
 * `worktrees/`, and that directory, not the main `.git`, is where its
 * `MERGE_HEAD` is written. Reading the main one instead would report a sibling
 * worktree's merge as this one's.
 *
 * Exported so the bridged translation it does can be asserted without a Windows
 * host to run the server on; `detectGitConflictOperation` is the only caller.
 */
export async function resolveWorktreeGitDir(
  worktreeFilesystemPath: string,
  agentEnvironment: AgentEnvironment,
): Promise<string> {
  const pathModule = getFilesystemPathModule(worktreeFilesystemPath);
  const dotGit = pathModule.join(worktreeFilesystemPath, ".git");

  const stats = await stat(dotGit);
  if (stats.isDirectory()) return dotGit;

  const contents = await readFile(dotGit, "utf8");
  const gitdir = contents.match(/^gitdir:\s*(.+?)\s*$/m)?.[1];
  if (!gitdir) return dotGit;

  // Git wrote this pointer in the world it ran in, so it needs the same
  // translation the worktree path did. Resolving it against the *already
  // translated* worktree instead would only be right by coincidence — the two
  // are then in different path styles, and joining them lands nowhere.
  //
  // It is allowed to be relative to the worktree, and a repository moved by hand
  // can leave it that way; then the worktree is the right thing to resolve it
  // against, and both sides of the join are already on this filesystem.
  return isAbsoluteFilesystemPath(gitdir)
    ? resolveAgentReportedPath(gitdir, agentEnvironment)
    : pathModule.resolve(worktreeFilesystemPath, gitdir);
}

async function exists(filesystemPath: string): Promise<boolean> {
  return stat(filesystemPath).then(
    () => true,
    () => false,
  );
}
