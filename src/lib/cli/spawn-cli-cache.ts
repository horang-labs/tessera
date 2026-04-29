import type { AgentEnvironment } from '../settings/types';

const SPAWN_CACHE_KEY = Symbol.for('tessera.spawnCliCache');

export interface SpawnCliCache {
  agentEnvironmentByUserId: Map<string, AgentEnvironment>;
  defaultAgentEnvironment: AgentEnvironment | null;
  loginShellPath: string | null;
  didResolveLoginShellPath: boolean;
  wslBinaryPaths: Map<string, string>;
  windowsNativeBinaryPaths: Map<string, string>;
}

export function getSpawnCliCache(): SpawnCliCache {
  return (
    globalThis as typeof globalThis & { [SPAWN_CACHE_KEY]?: SpawnCliCache }
  )[SPAWN_CACHE_KEY] ??= {
    agentEnvironmentByUserId: new Map(),
    defaultAgentEnvironment: null,
    loginShellPath: null,
    didResolveLoginShellPath: false,
    wslBinaryPaths: new Map(),
    windowsNativeBinaryPaths: new Map(),
  };
}
