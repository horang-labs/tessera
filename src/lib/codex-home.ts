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

export const CODEX_OVERLAY_MARKER = '.tessera-overlay.json';

/** 마커 파일 내용. WSL 게스트 오버레이(codex-overlay-wsl.ts)도 같은 계약을 쓴다. */
export function buildCodexOverlayMarkerJson(accountHome: string): string {
  return JSON.stringify({
    kind: 'tessera-codex-overlay',
    accountHome,
  }) + '\n';
}

export function writeCodexOverlayMarker(overlayHome: string, accountHome: string): void {
  fs.writeFileSync(
    path.join(overlayHome, CODEX_OVERLAY_MARKER),
    buildCodexOverlayMarkerJson(accountHome),
    { mode: 0o600 },
  );
}

function readMarkedAccountHome(overlayHome: string): string | undefined {
  try {
    const marker = JSON.parse(
      fs.readFileSync(path.join(overlayHome, CODEX_OVERLAY_MARKER), 'utf8'),
    ) as Record<string, unknown>;
    const accountHome = typeof marker.accountHome === 'string'
      ? marker.accountHome.trim()
      : '';
    if (
      marker.kind !== 'tessera-codex-overlay'
      || !accountHome
      || !path.isAbsolute(accountHome)
      || path.resolve(accountHome) === path.resolve(overlayHome)
    ) return undefined;
    return path.resolve(accountHome);
  } catch {
    return undefined;
  }
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
  const markedAccountHome = readMarkedAccountHome(resolvedHome);
  if (markedAccountHome) return markedAccountHome;
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

/**
 * `.../codex-overlay/session-<terminal-id>/<rest>` — matched by segment rather
 * than against a resolved data dir so it also recognises an overlay path that
 * was reported by a CLI in another environment (WSL guest, Windows host).
 */
const CODEX_OVERLAY_PATH_PATTERN = /^(.*)[/\\]codex-overlay[/\\](session-[^/\\]+)[/\\](.+)$/;

/**
 * Map a rollout path recorded under a per-session overlay home back to the real
 * account home.
 *
 * Overlays are deleted when the terminal closes (`cleanupCodexOverlayForTerminal`),
 * so a stored `transcript_path` pointing into one is dead on arrival. The
 * rollout itself survives: `sessions/` is a symlink into the account home, so
 * the same relative path resolves there.
 *
 * Non-overlay paths and unresolvable candidates are returned untouched — the
 * caller reports a missing transcript, which is the honest outcome.
 */
export function resolveCodexAccountTranscriptPath(
  transcriptPath: string,
  options: ResolveCodexAccountHomeOptions = {},
): string {
  const match = transcriptPath.match(CODEX_OVERLAY_PATH_PATTERN);
  if (!match) return transcriptPath;

  const [, dataDir, overlayName, relativePath] = match;
  const pathModule = /^[a-zA-Z]:[\\/]|^\\\\/.test(transcriptPath) ? path.win32 : path.posix;
  const segments = relativePath.split(/[/\\]/).filter(Boolean);

  const candidateHomes = [
    // The overlay is still on disk (session running): its marker is exact.
    readMarkedAccountHome(pathModule.join(dataDir, 'codex-overlay', overlayName)),
    // Default layout — the data dir sits next to `.codex` under the same home.
    pathModule.join(pathModule.dirname(dataDir), '.codex'),
    resolveCodexAccountHome(options),
  ];

  for (const accountHome of candidateHomes) {
    if (!accountHome) continue;
    const candidate = pathModule.join(accountHome, ...segments);
    if (fs.existsSync(candidate)) return candidate;
  }

  return transcriptPath;
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
