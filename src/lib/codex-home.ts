import fs from 'fs';
import os from 'os';
import path from 'path';
import type { CliEnvironment } from './cli/cli-exec';
import {
  getTesseraDataDir,
  resolveConfiguredPath,
} from './tessera-data-dir';

interface ResolveCodexAccountHomeOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  homeDir?: string;
}

function isWithin(candidate: string, parent: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * Resolves the user's real Codex account home. A Tessera PTY may set CODEX_HOME
 * to a per-session overlay, but account-wide background work must not inherit
 * that session scope.
 */
export function resolveCodexAccountHome(
  options: ResolveCodexAccountHomeOptions = {},
): string {
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? os.homedir();
  const defaultHome = path.join(homeDir, '.codex');
  const configuredHome = env.CODEX_HOME?.trim();
  if (!configuredHome) return defaultHome;

  const resolvedHome = resolveConfiguredPath(configuredHome, {
    cwd: options.cwd,
    homeDir,
  });
  const overlayRoot = path.join(getTesseraDataDir({
    env,
    cwd: options.cwd,
    homeDir,
  }), 'codex-overlay');
  if (!isWithin(resolvedHome, overlayRoot)) return resolvedHome;

  try {
    const realAuthPath = fs.realpathSync(path.join(resolvedHome, 'auth.json'));
    if (!isWithin(realAuthPath, overlayRoot)) {
      return path.dirname(realAuthPath);
    }
  } catch {
    // An incomplete/stale session overlay has no account link. Use the default.
  }

  return defaultHome;
}

export function buildCodexAccountEnvironment(
  baseEnv: NodeJS.ProcessEnv = process.env,
  agentEnvironment: CliEnvironment = 'native',
): NodeJS.ProcessEnv {
  const env = { ...baseEnv };
  if (agentEnvironment === 'wsl') {
    delete env.CODEX_HOME;
    return env;
  }

  env.CODEX_HOME = resolveCodexAccountHome({ env: baseEnv });
  return env;
}
