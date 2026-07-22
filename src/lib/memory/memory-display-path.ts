import { formatPathForAgentDisplay } from "@/lib/filesystem/path-environment";
import type { CliEnvironment } from "@/lib/cli/cli-exec";

/**
 * Memory paths are resolved against the host filesystem so the server can read
 * and write them, but a WSL bridge means that host form is not the form the
 * CLI reads: a session running in WSL loads `/home/u/.claude/CLAUDE.md`, which
 * the Windows-hosted server only reaches as
 * `\\wsl.localhost\<distro>\home\u\.claude\CLAUDE.md` (and vice versa when the
 * server itself runs inside WSL while the agent is a native Windows CLI).
 *
 * Showing the host form makes the panel disagree with everything the agent
 * prints, so display paths are translated to the CLI's view while the host
 * path is kept alongside for Electron's open/reveal actions.
 */
export function toMemoryDisplayPath(
  filesystemPath: string,
  environment: CliEnvironment,
): string {
  return formatPathForAgentDisplay(filesystemPath, environment);
}

export function toOptionalMemoryDisplayPath(
  filesystemPath: string | null,
  environment: CliEnvironment,
): string | null {
  return filesystemPath ? toMemoryDisplayPath(filesystemPath, environment) : null;
}
