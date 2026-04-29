/**
 * CLI spawn helper — bridges WSL on Windows when agentEnvironment is 'wsl'.
 *
 * Public responsibilities:
 * - resolve the configured agent environment
 * - invalidate shared caches when settings change
 * - expose PATH-normalized env + spawn entrypoint
 *
 * Platform/path probing details live in spawn-cli-runtime.ts.
 */
import type { ChildProcess, SpawnOptions } from 'child_process';
import { SettingsManager } from '../settings/manager';
import type { AgentEnvironment } from '../settings/types';
import { getSpawnCliCache } from './spawn-cli-cache';
import {
  buildSpawnEnvironment,
  invalidateSpawnCliRuntimeCache,
  normalizeCwdForCliEnvironment,
  resolveDefaultAgentEnvironment,
  spawnCliProcess,
} from './spawn-cli-runtime';

const spawnCliCache = getSpawnCliCache();

/**
 * Resolve the agent environment setting.
 * Cached per user in globalThis so Next route handlers and the WS server share it.
 */
export async function getAgentEnvironment(userId?: string): Promise<AgentEnvironment> {
  if (userId) {
    const cachedEnvironment = spawnCliCache.agentEnvironmentByUserId.get(userId);
    if (cachedEnvironment) {
      return cachedEnvironment;
    }

    try {
      const settings = await SettingsManager.load(userId);
      const resolvedEnvironment = settings.agentEnvironment || 'native';
      spawnCliCache.agentEnvironmentByUserId.set(userId, resolvedEnvironment);
      return resolvedEnvironment;
    } catch {
      // Fall through to platform detection
    }
  }

  if (!spawnCliCache.defaultAgentEnvironment) {
    spawnCliCache.defaultAgentEnvironment = resolveDefaultAgentEnvironment();
  }

  return spawnCliCache.defaultAgentEnvironment;
}

/** Invalidate the cached environment (call when settings change). */
export function invalidateAgentEnvironmentCache(userId?: string): void {
  if (userId) {
    spawnCliCache.agentEnvironmentByUserId.delete(userId);
  } else {
    spawnCliCache.agentEnvironmentByUserId.clear();
    spawnCliCache.defaultAgentEnvironment = null;
  }

  invalidateSpawnCliRuntimeCache(spawnCliCache);
}

/**
 * Finder-launched Electron apps do not inherit the user's login-shell PATH.
 * Merge it back in so globally installed CLIs remain discoverable.
 */
export function buildSpawnEnv(baseEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return buildSpawnEnvironment(baseEnv, spawnCliCache);
}

export { normalizeCwdForCliEnvironment };

/**
 * Spawn a CLI command with WSL bridge support.
 * Returns the same ChildProcess as child_process.spawn.
 */
export function spawnCli(
  command: string,
  args: string[],
  options: SpawnOptions,
  agentEnv: AgentEnvironment,
): ChildProcess {
  return spawnCliProcess(command, args, options, agentEnv, spawnCliCache);
}
