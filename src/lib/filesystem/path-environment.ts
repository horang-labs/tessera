import { execFile } from 'child_process';
import { access, constants } from 'fs/promises';
import { homedir } from 'os';
import path from 'path';
import { promisify } from 'util';
import { isRunningInWsl } from '@/lib/cli/cli-exec';
import { getRuntimePlatform } from '@/lib/system/runtime-platform';
import type { AgentEnvironment } from '@/lib/settings/types';

const execFileAsync = promisify(execFile);

export type FilesystemBrowseEnvironment = AgentEnvironment;

export interface WslPathInfo {
  homeDisplayPath: string;
  homeFilesystemPath: string;
  rootFilesystemPath: string;
}

interface BrowsePathResolution {
  displayPath: string;
  filesystemPath: string;
}

let wslPathInfoPromise: Promise<WslPathInfo | null> | null = null;
let wslHostedWindowsHomeMountPathPromise: Promise<string> | null = null;

export function normalizeFilesystemBrowseEnvironment(
  value: string | null | undefined,
): FilesystemBrowseEnvironment {
  return value === 'wsl' ? 'wsl' : 'native';
}

export async function resolveBrowsePath(
  rawPath: string | null | undefined,
  environment: FilesystemBrowseEnvironment,
): Promise<BrowsePathResolution> {
  if (environment === 'wsl' && getRuntimePlatform() === 'win32') {
    const wslPathInfo = await getWslPathInfo();
    if (!wslPathInfo) {
      throw new Error('WSL filesystem is not available');
    }
    return resolveWindowsHostedWslBrowsePath(rawPath, wslPathInfo);
  }

  if (environment === 'native' && getRuntimePlatform() === 'linux' && isRunningInWsl()) {
    const windowsHomeMountPath = await getWslHostedWindowsHomeMountPath();
    return resolveWslHostedNativeBrowsePath(rawPath, windowsHomeMountPath);
  }

  const filesystemPath = resolveNativeFilesystemPath(rawPath?.trim() || homedir());
  return {
    displayPath: filesystemPath,
    filesystemPath,
  };
}

export async function formatBrowsePathForDisplay(
  filesystemPath: string,
  environment: FilesystemBrowseEnvironment,
): Promise<string> {
  if (environment === 'wsl' && getRuntimePlatform() === 'win32') {
    const wslPathInfo = await getWslPathInfo();
    return formatWindowsHostedWslDisplayPath(filesystemPath, wslPathInfo);
  }

  return filesystemPath;
}

/**
 * Rewrite a host filesystem path into the form the CLI for `environment`
 * actually sees, so the UI never shows a path the agent could not open.
 *
 * Both bridges are asymmetric, and each needs the opposite translation:
 * - Windows host, WSL agent: the server reaches the distro through
 *   `\\wsl.localhost\<distro>\home\u` and drives through `C:\`, while the CLI
 *   sees `/home/u` and `/mnt/c`.
 * - WSL host, native (Windows) agent: the server reaches the Windows side
 *   through `/mnt/c` and its own files directly, while the CLI sees `C:\` and
 *   reaches the distro back through the `\\wsl.localhost` share.
 *
 * This mirrors `normalizeCwdForCliEnvironment`, which computes the cwd the CLI
 * is actually spawned with; the two must agree, or the panel would show a path
 * that disagrees with the directory the agent reads (the Claude memory slug is
 * derived from that same cwd). Non-bridged setups (Windows host + native agent,
 * Linux host + WSL agent) already share one path style, so this is a no-op.
 */
export function formatPathForAgentDisplay(
  filesystemPath: string,
  environment: FilesystemBrowseEnvironment,
): string {
  if (environment === 'wsl') {
    return formatWindowsHostedWslDisplayPath(filesystemPath, null);
  }

  if (getRuntimePlatform() === 'linux' && isRunningInWsl()) {
    return formatWslHostedNativeDisplayPath(filesystemPath);
  }

  return filesystemPath;
}

/**
 * Rewrite a path the CLI reported — hook payloads, provider transcript
 * locations — into the form this server can open. Inverse of
 * `formatPathForAgentDisplay`: the CLI names files in its own environment's
 * style, so across a bridge the server must translate before touching disk.
 *
 * Non-bridged setups already share one path style, so this is a no-op.
 */
export async function resolveAgentReportedPath(
  agentPath: string,
  environment: FilesystemBrowseEnvironment,
): Promise<string> {
  const trimmed = agentPath.trim();
  if (!trimmed) return agentPath;
  if (!isBridgedAgentEnvironment(environment)) return trimmed;

  if (environment === 'wsl') {
    // Callers at a routing seam may already hold the Windows server's path
    // spelling. Treat host-openable paths idempotently instead of prepending
    // the WSL share a second time.
    if (wslUncPathToDisplayPath(trimmed) || isWindowsDrivePath(trimmed)) {
      return path.win32.normalize(trimmed);
    }
    const wslPathInfo = await getWslPathInfo();
    return wslPathInfo
      ? wslDisplayPathToWindowsFilesystemPath(trimmed, wslPathInfo)
      : trimmed;
  }

  return windowsDrivePathToWslMountPath(trimmed) ?? trimmed;
}

/**
 * Whether the agent's files live on a different filesystem than the server's.
 *
 * Only bridged setups need translation: Windows host with a WSL agent, and WSL
 * host with a native (Windows) agent. Windows host + native agent and Linux
 * host + WSL agent already share one filesystem and one path style.
 */
export function isBridgedAgentEnvironment(
  environment: FilesystemBrowseEnvironment,
): boolean {
  return environment === 'wsl'
    ? getRuntimePlatform() === 'win32'
    : getRuntimePlatform() === 'linux' && isRunningInWsl();
}

/**
 * The home directory the agent's CLI writes under, as a path this server can
 * open. Across a bridge the server's own `homedir()` belongs to the wrong side:
 * a Windows host resolving `~/.claude` for a WSL agent lands in `C:\Users\...`,
 * which holds another account's transcripts or none at all.
 *
 * Callers pairing this with an env var (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`,
 * `XDG_DATA_HOME`) must drop the var when `isBridgedAgentEnvironment` is true:
 * those describe the server's own environment, not the CLI's.
 */
export async function resolveAgentHomeFilesystemPath(
  environment: FilesystemBrowseEnvironment,
): Promise<string> {
  if (!isBridgedAgentEnvironment(environment)) return homedir();
  return (await resolveBrowsePath(null, environment)).filesystemPath;
}

function formatWslHostedNativeDisplayPath(filesystemPath: string): string {
  const windowsDrivePath = wslMountPathToWindowsDrivePath(filesystemPath);
  if (windowsDrivePath) return windowsDrivePath;
  if (isWindowsStylePath(filesystemPath)) return filesystemPath;

  // A distro-local path: a Windows CLI can only reach it over the UNC share.
  // Without a distro name there is no share to name, so the raw path is still
  // the most useful thing to show.
  return buildWslUncPath(process.env.WSL_DISTRO_NAME, filesystemPath) ?? filesystemPath;
}

export function getFilesystemPathBasename(filesystemPath: string): string {
  const normalized = filesystemPath.trim();
  if (!normalized) return '';
  const pathModule = isWindowsStylePath(normalized) ? path.win32 : path;
  return pathModule.basename(pathModule.normalize(normalized));
}

export function isWindowsHostedWslFilesystemPath(filesystemPath: string): boolean {
  return getWindowsHostedWslRootFilesystemPath(filesystemPath) !== null;
}

export function isWslFilesystemPath(filesystemPath: string): boolean {
  const trimmed = filesystemPath.trim();
  if (isWindowsHostedWslFilesystemPath(trimmed)) return true;
  if (getRuntimePlatform() !== 'linux' || !isRunningInWsl()) return false;

  const normalized = trimmed.replace(/\\/g, '/');
  return normalized.startsWith('/') && !isWindowsDriveMountPath(normalized);
}

export function getWindowsHostedWslRootFilesystemPath(filesystemPath: string): string | null {
  const normalized = filesystemPath.replace(/\//g, '\\');
  const match = normalized.match(/^(\\\\(?:wsl\.localhost|wsl\$)\\[^\\]+)(?:\\.*)?$/i);
  return match ? path.win32.normalize(match[1]) : null;
}

export function resolveWslDisplayPathAgainstWindowsHostedPath(
  displayPath: string,
  referenceFilesystemPath: string,
): string | null {
  const mountedDriveMatch = normalizeWslDisplayPath(displayPath)
    .match(/^\/mnt\/([a-zA-Z])(?:\/(.*))?$/);
  if (mountedDriveMatch) {
    const drive = mountedDriveMatch[1].toUpperCase();
    const rest = mountedDriveMatch[2]?.replace(/\//g, '\\') ?? '';
    return rest ? `${drive}:\\${rest}` : `${drive}:\\`;
  }

  const rootFilesystemPath = getWindowsHostedWslRootFilesystemPath(referenceFilesystemPath);
  if (!rootFilesystemPath) return null;

  const normalizedDisplayPath = normalizeWslDisplayPath(displayPath);
  if (normalizedDisplayPath === '/') return rootFilesystemPath;

  return path.win32.join(
    rootFilesystemPath,
    ...normalizedDisplayPath.split('/').filter(Boolean),
  );
}

export function getBrowseParentPath(
  displayPath: string,
  filesystemPath: string,
  environment: FilesystemBrowseEnvironment,
): string | null {
  if (environment === 'wsl' && getRuntimePlatform() === 'win32') {
    const normalizedDisplayPath = normalizeWslDisplayPath(displayPath);
    if (normalizedDisplayPath === '/') return null;
    return path.posix.dirname(normalizedDisplayPath);
  }

  const pathModule = isWindowsStylePath(filesystemPath) ? path.win32 : path;
  const normalizedFilesystemPath = pathModule.resolve(filesystemPath);
  const parentPath = pathModule.dirname(normalizedFilesystemPath);
  return parentPath === normalizedFilesystemPath ? null : parentPath;
}

export function resolveNativeFilesystemPath(rawPath: string): string {
  const trimmed = rawPath.trim();
  if (isWindowsStylePath(trimmed)) {
    return path.win32.normalize(trimmed);
  }
  return path.resolve(trimmed);
}

export function resolveWindowsHostedWslBrowsePath(
  rawPath: string | null | undefined,
  wslPathInfo: WslPathInfo,
): BrowsePathResolution {
  const trimmed = rawPath?.trim();
  if (!trimmed) {
    return {
      displayPath: wslPathInfo.homeDisplayPath,
      filesystemPath: wslPathInfo.homeFilesystemPath,
    };
  }

  if (trimmed === '~' || trimmed.startsWith('~/')) {
    const displayPath = normalizeWslDisplayPath(
      path.posix.join(wslPathInfo.homeDisplayPath, trimmed.slice(2)),
    );
    return {
      displayPath,
      filesystemPath: wslDisplayPathToWindowsFilesystemPath(displayPath, wslPathInfo),
    };
  }

  const uncWslDisplayPath = wslUncPathToDisplayPath(trimmed);
  if (uncWslDisplayPath) {
    return {
      displayPath: uncWslDisplayPath,
      filesystemPath: path.win32.normalize(trimmed),
    };
  }

  if (isWindowsDrivePath(trimmed)) {
    const filesystemPath = path.win32.normalize(trimmed);
    return {
      displayPath: windowsDrivePathToWslMountPath(filesystemPath) ?? filesystemPath,
      filesystemPath,
    };
  }

  if (trimmed.startsWith('/')) {
    const displayPath = normalizeWslDisplayPath(trimmed);
    return {
      displayPath,
      filesystemPath: wslDisplayPathToWindowsFilesystemPath(displayPath, wslPathInfo),
    };
  }

  const displayPath = normalizeWslDisplayPath(
    path.posix.join(wslPathInfo.homeDisplayPath, trimmed),
  );
  return {
    displayPath,
    filesystemPath: wslDisplayPathToWindowsFilesystemPath(displayPath, wslPathInfo),
  };
}

export function resolveWslHostedNativeBrowsePath(
  rawPath: string | null | undefined,
  windowsHomeMountPath: string,
): BrowsePathResolution {
  const homeMountPath = path.posix.resolve(windowsHomeMountPath);
  const trimmed = rawPath?.trim();
  if (!trimmed) {
    return {
      displayPath: homeMountPath,
      filesystemPath: homeMountPath,
    };
  }

  if (trimmed === '~' || trimmed.startsWith('~/')) {
    const filesystemPath = path.posix.resolve(homeMountPath, trimmed.slice(2));
    return {
      displayPath: filesystemPath,
      filesystemPath,
    };
  }

  if (isWindowsDrivePath(trimmed)) {
    const filesystemPath = windowsDrivePathToWslMountPath(trimmed) ?? trimmed;
    return {
      displayPath: filesystemPath,
      filesystemPath,
    };
  }

  const filesystemPath = trimmed.startsWith('/')
    ? path.posix.resolve(trimmed)
    : path.posix.resolve(homeMountPath, trimmed);
  return {
    displayPath: filesystemPath,
    filesystemPath,
  };
}

export function formatWindowsHostedWslDisplayPath(
  filesystemPath: string,
  wslPathInfo: WslPathInfo | null,
): string {
  return (
    windowsDrivePathToWslMountPath(filesystemPath)
    ?? wslUncPathToDisplayPath(filesystemPath)
    ?? (wslPathInfo ? stripWslRoot(filesystemPath, wslPathInfo.rootFilesystemPath) : null)
    ?? filesystemPath
  );
}

function normalizeWslDisplayPath(value: string): string {
  const normalized = path.posix.normalize(value.replace(/\\/g, '/'));
  return normalized.startsWith('/') ? normalized : `/${normalized}`;
}

export function wslDisplayPathToWindowsFilesystemPath(
  displayPath: string,
  wslPathInfo: WslPathInfo,
): string {
  const normalizedDisplayPath = normalizeWslDisplayPath(displayPath);
  const windowsDrivePath = wslMountPathToWindowsDrivePath(normalizedDisplayPath);
  if (windowsDrivePath) return windowsDrivePath;

  if (normalizedDisplayPath === '/') {
    return wslPathInfo.rootFilesystemPath;
  }

  return path.win32.join(
    wslPathInfo.rootFilesystemPath,
    ...normalizedDisplayPath.split('/').filter(Boolean),
  );
}

export function windowsDrivePathToWslMountPath(value: string): string | null {
  const driveMatch = value.match(/^([a-zA-Z]):[\\/]*(.*)$/);
  if (!driveMatch) return null;

  const drive = driveMatch[1].toLowerCase();
  const rest = driveMatch[2].replace(/[\\/]+/g, '/').replace(/^\/+/, '');
  return rest ? `/mnt/${drive}/${rest}` : `/mnt/${drive}`;
}

export function wslMountPathToWindowsDrivePath(value: string): string | null {
  const normalized = path.posix.normalize(value.replace(/\\/g, '/'));
  const mountedDriveMatch = normalized.match(/^\/mnt\/([a-zA-Z])(?:\/(.*))?$/);
  if (!mountedDriveMatch) return null;

  const drive = mountedDriveMatch[1].toUpperCase();
  const rest = mountedDriveMatch[2]?.replace(/\//g, '\\') ?? '';
  return rest ? `${drive}:\\${rest}` : `${drive}:\\`;
}

function wslUncPathToDisplayPath(value: string): string | null {
  const normalized = value.replace(/\//g, '\\');
  const match = normalized.match(/^\\\\(?:wsl\.localhost|wsl\$)\\([^\\]+)(?:\\(.*))?$/i);
  if (!match) return null;

  const rest = match[2]?.replace(/\\/g, '/').replace(/^\/+/, '') ?? '';
  return rest ? `/${rest}` : '/';
}

function stripWslRoot(value: string, rootFilesystemPath: string): string | null {
  const normalizedValue = path.win32.normalize(value).toLowerCase();
  const normalizedRoot = path.win32.normalize(rootFilesystemPath).toLowerCase();
  if (normalizedValue === normalizedRoot) return '/';
  if (!normalizedValue.startsWith(`${normalizedRoot}\\`)) return null;

  const rest = path.win32
    .normalize(value)
    .slice(path.win32.normalize(rootFilesystemPath).length)
    .replace(/^[\\/]+/, '')
    .replace(/\\/g, '/');
  return rest ? `/${rest}` : '/';
}

function isWindowsStylePath(value: string): boolean {
  return isWindowsDrivePath(value) || value.startsWith('\\\\') || value.startsWith('//');
}

function isWindowsDrivePath(value: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(value) || /^[a-zA-Z]:$/.test(value);
}

function isWindowsDriveMountPath(value: string): boolean {
  return /^\/mnt\/[a-zA-Z](?:\/|$)/.test(value.replace(/\\/g, '/'));
}

async function getWslPathInfo(): Promise<WslPathInfo | null> {
  if (!wslPathInfoPromise) {
    wslPathInfoPromise = loadWslPathInfo().catch(() => null);
  }

  const wslPathInfo = await wslPathInfoPromise;
  // Only a successful probe is cached. A failure is usually a race with a
  // distro that was still starting, and caching it would strand every later
  // WSL path lookup — file browsing, git, inline images — until restart.
  if (!wslPathInfo) wslPathInfoPromise = null;
  return wslPathInfo;
}

export async function getWslHostedWindowsHomeMountPath(): Promise<string> {
  if (!wslHostedWindowsHomeMountPathPromise) {
    wslHostedWindowsHomeMountPathPromise = resolveWslHostedWindowsHomeMountPath();
  }
  return wslHostedWindowsHomeMountPathPromise;
}

async function resolveWslHostedWindowsHomeMountPath(): Promise<string> {
  const { stdout } = await execFileAsync(
    'cmd.exe',
    ['/d', '/c', 'echo %USERPROFILE%'],
    {
      encoding: 'utf8',
      timeout: 3000,
      windowsHide: true,
    },
  );
  const userProfile = stdout.replace(/\0/g, '').trim();
  const mountPath = windowsDrivePathToWslMountPath(userProfile);
  if (!mountPath || !(await directoryExists(mountPath))) {
    throw new Error('Windows user profile filesystem is not available from WSL');
  }
  return mountPath;
}

async function loadWslPathInfo(): Promise<WslPathInfo | null> {
  if (getRuntimePlatform() !== 'win32') return null;

  const wslCandidates = getWslExecutableCandidates();
  for (const wslExecutable of wslCandidates) {
    const parsed = await probeWslPathInfo(wslExecutable);
    if (parsed) return parsed;
  }

  const discoveredFromDistroList = await discoverWslPathInfoFromDistroList(wslCandidates);
  if (discoveredFromDistroList) return discoveredFromDistroList;
  return null;
}

async function probeWslPathInfo(
  wslExecutable: string,
  distroName?: string,
): Promise<WslPathInfo | null> {
  const script = [
    'printf "%s\\n" "${WSL_DISTRO_NAME:-}"',
    'printf "%s\\n" "$HOME"',
    'wslpath -w "$HOME" 2>/dev/null || true',
  ].join('; ');
  const args = distroName
    ? ['-d', distroName, '-e', 'sh', '-c', script]
    : ['-e', 'sh', '-c', script];
  try {
    const { stdout } = await execFileAsync(wslExecutable, args, {
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true,
    });
    return parseWslPathInfo(stdout);
  } catch {
    return null;
  }
}

function parseWslPathInfo(stdout: string): WslPathInfo | null {
    const lines = stdout
      .replace(/\0/g, '')
      .split(/\r?\n/)
      .map((line) => line.trim());
    const distroName = lines[0];
    const homeDisplayPath = normalizeWslDisplayPath(lines[1] || '/');
    const homeFilesystemPath = path.win32.normalize(
      lines[2] || buildWslUncPath(distroName, homeDisplayPath) || '',
    );
    const rootFilesystemPath = getWslRootFilesystemPath(homeFilesystemPath);
    if (!homeFilesystemPath || !rootFilesystemPath) return null;

    return {
      homeDisplayPath,
      homeFilesystemPath,
      rootFilesystemPath,
    };
}

function buildWslUncPath(distroName: string | undefined, displayPath: string): string | null {
  const distro = distroName?.trim();
  if (!distro) return null;

  return path.win32.join(
    `\\\\wsl.localhost\\${distro}`,
    ...normalizeWslDisplayPath(displayPath).split('/').filter(Boolean),
  );
}

function getWslExecutableCandidates(): string[] {
  const candidates = ['wsl.exe', 'wsl'];
  const windowsRoot = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
  candidates.push(
    path.win32.join(windowsRoot, 'System32', 'wsl.exe'),
    path.win32.join(windowsRoot, 'Sysnative', 'wsl.exe'),
  );

  return [...new Set(candidates)];
}

async function discoverWslPathInfoFromDistroList(
  wslExecutables: string[],
): Promise<WslPathInfo | null> {
  for (const wslExecutable of wslExecutables) {
    let distroNames: string[];
    try {
      const { stdout } = await execFileAsync(wslExecutable, ['-l', '-q'], {
        encoding: 'utf16le',
        timeout: 5000,
        windowsHide: true,
      });
      distroNames = parseWslDistroNames(stdout);
    } catch {
      continue;
    }

    if (distroNames.length !== 1) continue;

    for (const distroName of distroNames) {
      const probed = await probeWslPathInfo(wslExecutable, distroName);
      if (probed) return probed;
    }
  }

  return null;
}

function parseWslDistroNames(stdout: string): string[] {
  const withoutNuls = stdout.replace(/\0/g, '');
  return [...new Set(
    withoutNuls
      .split(/\r?\n/)
      .map((line) => line.trim())
      .map((line) => line.replace(/\s+\(Default\)$/i, '').trim())
      .filter((line) => line.length > 0 && !line.toLowerCase().startsWith('windows subsystem')),
  )];
}

async function directoryExists(candidate: string): Promise<boolean> {
  try {
    await access(candidate, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function getWslRootFilesystemPath(filesystemPath: string): string | null {
  return getWindowsHostedWslRootFilesystemPath(filesystemPath);
}
