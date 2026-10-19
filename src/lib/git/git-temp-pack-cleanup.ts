/**
 * Removing the half-written packs an interrupted fetch leaves behind.
 *
 * `git fetch` streams the incoming pack into `objects/pack/tmp_pack_*` and only
 * renames it once the transfer is complete. A fetch that dies first — the
 * runner's timeout sends SIGKILL, so Git never gets to clean up — leaves the
 * partial file where it is, and nothing in Git removes it until a `git gc`
 * prunes it two weeks later. The Git panel's background fetch made this a disk
 * leak the user never sees: a remote whose next fetch was larger than the
 * deadline allowed failed the same way every interval, and one repository
 * accumulated 1,553 of these files (127GB) in two weeks.
 *
 * Tessera started those fetches, so Tessera cleans up after them, before each
 * new one. The rule is Git's own (`git prune`'s `remove_temporary_files`): any
 * `tmp_` file in the pack directory older than the expiry. A pack still being
 * written has its modification time bumped by every write, so the age alone
 * keeps a concurrent fetch — the user's own, in a terminal — from losing its
 * file.
 */
import { lstat, readdir, unlink } from "fs/promises";
import { getFilesystemPathModule } from "@/lib/filesystem/host-path";
import { resolveAgentReportedPath } from "@/lib/filesystem/path-environment";
import logger from "@/lib/logger";
import type { AgentEnvironment } from "@/lib/settings/types";

/**
 * How old an untouched temporary file must be before it is treated as
 * abandoned. Far past any write gap of a live transfer, and short enough that a
 * repository failing every fetch carries at most an hour of leftovers.
 */
export const STALE_GIT_TEMP_FILE_AGE_MS = 60 * 60 * 1000;

export interface GitTempPackCleanupResult {
  removedFiles: number;
  removedBytes: number;
}

/**
 * `gitCommonDir` is a path Git reported, so on a bridged setup it names a file
 * on the other side and goes through `resolveAgentReportedPath` first.
 *
 * Never rejects: the cleanup is housekeeping in front of a fetch and must not
 * become the reason the fetch does not run.
 */
export async function removeStaleGitTempPacks(
  gitCommonDir: string,
  agentEnvironment: AgentEnvironment,
  now: number = Date.now(),
): Promise<GitTempPackCleanupResult> {
  const result: GitTempPackCleanupResult = { removedFiles: 0, removedBytes: 0 };
  let packDir: string;
  let names: string[];
  try {
    const commonDir = await resolveAgentReportedPath(gitCommonDir, agentEnvironment);
    packDir = getFilesystemPathModule(commonDir).join(commonDir, "objects", "pack");
    names = await readdir(packDir);
  } catch (error) {
    logger.debug({ error, gitCommonDir }, "Could not list the Git pack directory for cleanup");
    return result;
  }

  const pathModule = getFilesystemPathModule(packDir);
  for (const name of names) {
    if (!name.startsWith("tmp_")) continue;
    const filePath = pathModule.join(packDir, name);
    try {
      const stats = await lstat(filePath);
      if (!stats.isFile()) continue;
      if (now - stats.mtimeMs < STALE_GIT_TEMP_FILE_AGE_MS) continue;
      await unlink(filePath);
      result.removedFiles += 1;
      result.removedBytes += stats.size;
    } catch (error) {
      // Gone already (another cleanup, a `git gc`) or not ours to remove;
      // either way the next file is still worth trying.
      logger.debug({ error, filePath }, "Could not remove a stale Git temporary pack");
    }
  }

  if (result.removedFiles > 0) {
    logger.info(
      { gitCommonDir, ...result },
      "Removed temporary packs left by interrupted Git fetches",
    );
  }
  return result;
}
