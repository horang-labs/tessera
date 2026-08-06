/**
 * The one place a Git invocation decides which environment to run in.
 *
 * The `agentEnvironment` setting is authoritative (ADR 0006): project
 * registration already refuses a WSL folder under a native agent and vice
 * versa, so in the normal path the setting and the repository's location cannot
 * disagree. Inferring from the path would add a second source of truth for a
 * fact the product constrains to one value.
 *
 * Path inference survives only where there is no user to ask — the cleanup
 * paths. It is a separate, explicitly named argument rather than a default,
 * because `getAgentEnvironment(undefined)` resolves to `'native'`
 * unconditionally, and `native` inside WSL spawns *Windows* binaries
 * (`spawn-cli-runtime.ts:175`), which cannot touch a distro-local worktree.
 */
import { getAgentEnvironment } from '@/lib/cli/spawn-cli';
import { isWslFilesystemPath } from '@/lib/filesystem/path-environment';
import type { AgentEnvironment } from '@/lib/settings/types';
import { getRuntimePlatform } from '@/lib/system/runtime-platform';

/**
 * Where the environment comes from. A union rather than an optional `userId`,
 * so a new caller cannot reach path inference by leaving an argument out — it
 * has to say `inferFromPaths` and be read as having said it.
 */
export type GitEnvironmentSource =
  | { readonly userId: string }
  | { readonly inferFromPaths: readonly string[] };

export async function resolveGitEnvironment(
  source: GitEnvironmentSource,
): Promise<AgentEnvironment> {
  if ('userId' in source) {
    return getAgentEnvironment(source.userId);
  }

  return source.inferFromPaths.some(looksLikeWslPath) ? 'wsl' : 'native';
}

/**
 * Union of the two rules this replaces. `isWslFilesystemPath` covers the UNC
 * form on any platform and distro-local paths when the server itself runs in
 * WSL; the second clause covers a Windows server handed a posix path, which
 * `isWslFilesystemPath` reports as native because the server is not in WSL.
 */
function looksLikeWslPath(candidate: string): boolean {
  if (isWslFilesystemPath(candidate)) return true;
  return getRuntimePlatform() === 'win32' && candidate.trim().startsWith('/');
}
