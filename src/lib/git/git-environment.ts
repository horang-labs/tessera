/**
 * Which environment a Git command runs in, and the only place path inference
 * lives. The setting is authoritative; inference covers only the paths that
 * run without a user, where `native` is not a safe default — inside WSL it
 * spawns Windows binaries (`spawn-cli-runtime.ts:175`). Rationale: ADR 0006.
 */
import { getAgentEnvironment } from '@/lib/cli/spawn-cli';
import { isWslFilesystemPath } from '@/lib/filesystem/path-environment';
import type { AgentEnvironment } from '@/lib/settings/types';
import { getRuntimePlatform } from '@/lib/system/runtime-platform';

/** A union, so inference cannot be reached by omitting an argument. */
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

function looksLikeWslPath(candidate: string): boolean {
  // isWslFilesystemPath covers the UNC form anywhere, and distro-local paths
  // when this server runs in WSL. It reports native for a posix path on a
  // Windows server, which the second clause catches.
  if (isWslFilesystemPath(candidate)) return true;
  return getRuntimePlatform() === 'win32' && candidate.trim().startsWith('/');
}
