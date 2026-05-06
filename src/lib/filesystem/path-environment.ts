import { execFile } from 'child_process';
import { access, constants, readdir } from 'fs/promises';
import { homedir } from 'os';
import path from 'path';
import { promisify } from 'util';
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

export function formatPathForAgentDisplay(
  filesystemPath: string,
  environment: FilesystemBrowseEnvironment,
): string {
  if (environment !== 'wsl') return filesystemPath;
  return formatWindowsHostedWslDisplayPath(filesystemPath, null);
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
      displayPath: windowsDrivePathToWslDisplayPath(filesystemPath) ?? filesystemPath,
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

export function formatWindowsHostedWslDisplayPath(
  filesystemPath: string,
  wslPathInfo: WslPathInfo | null,
): string {
  return (
    windowsDrivePathToWslDisplayPath(filesystemPath)
    ?? wslUncPathToDisplayPath(filesystemPath)
    ?? (wslPathInfo ? stripWslRoot(filesystemPath, wslPathInfo.rootFilesystemPath) : null)
    ?? filesystemPath
  );
}

function normalizeWslDisplayPath(value: string): string {
  const normalized = path.posix.normalize(value.replace(/\\/g, '/'));
  return normalized.startsWith('/') ? normalized : `/${normalized}`;
}

function wslDisplayPathToWindowsFilesystemPath(
  displayPath: string,
  wslPathInfo: WslPathInfo,
): string {
  const normalizedDisplayPath = normalizeWslDisplayPath(displayPath);
  const mountedDriveMatch = normalizedDisplayPath.match(/^\/mnt\/([a-zA-Z])(?:\/(.*))?$/);
  if (mountedDriveMatch) {
    const drive = mountedDriveMatch[1].toUpperCase();
    const rest = mountedDriveMatch[2]?.replace(/\//g, '\\') ?? '';
    return rest ? `${drive}:\\${rest}` : `${drive}:\\`;
  }

  if (normalizedDisplayPath === '/') {
    return wslPathInfo.rootFilesystemPath;
  }

  return path.win32.join(
    wslPathInfo.rootFilesystemPath,
    ...normalizedDisplayPath.split('/').filter(Boolean),
  );
}

function windowsDrivePathToWslDisplayPath(value: string): string | null {
  const driveMatch = value.match(/^([a-zA-Z]):[\\/]*(.*)$/);
  if (!driveMatch) return null;

  const drive = driveMatch[1].toLowerCase();
  const rest = driveMatch[2].replace(/[\\/]+/g, '/').replace(/^\/+/, '');
  return rest ? `/mnt/${drive}/${rest}` : `/mnt/${drive}`;
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

async function getWslPathInfo(): Promise<WslPathInfo | null> {
  if (!wslPathInfoPromise) {
    wslPathInfoPromise = loadWslPathInfo();
  }
  return wslPathInfoPromise;
}

async function loadWslPathInfo(): Promise<WslPathInfo | null> {
  if (getRuntimePlatform() !== 'win32') return null;

  const wslCandidates = getWslExecutableCandidates();
  const script = [
    'printf "%s\\n" "${WSL_DISTRO_NAME:-}"',
    'printf "%s\\n" "$HOME"',
    'wslpath -w "$HOME" 2>/dev/null || true',
  ].join('; ');

  for (const wslExecutable of wslCandidates) {
    try {
      const { stdout } = await execFileAsync(
        wslExecutable,
        ['-e', 'sh', '-c', script],
        {
          encoding: 'utf8',
          timeout: 5000,
          windowsHide: true,
        },
      );
      const parsed = parseWslPathInfo(stdout);
      if (parsed) return parsed;
    } catch {
      // Try the next executable candidate.
    }
  }

  const discoveredFromDistroList = await discoverWslPathInfoFromDistroList(wslCandidates);
  if (discoveredFromDistroList) return discoveredFromDistroList;

  return discoverWslPathInfoFromUnc();
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

async function discoverWslPathInfoFromUnc(): Promise<WslPathInfo | null> {
  const namespaceRoots = ['\\\\wsl.localhost', '\\\\wsl$'];
  for (const namespaceRoot of namespaceRoots) {
    let distroNames: string[];
    try {
      distroNames = await readdir(namespaceRoot);
    } catch {
      continue;
    }

    for (const distroName of distroNames.filter((name) => name.trim().length > 0)) {
      const rootFilesystemPath = path.win32.join(namespaceRoot, distroName);
      const homeCandidate = await resolveBestWslHomeCandidate(rootFilesystemPath);
      if (homeCandidate) {
        return {
          homeDisplayPath: homeCandidate.displayPath,
          homeFilesystemPath: homeCandidate.filesystemPath,
          rootFilesystemPath,
        };
      }

      if (await directoryExists(rootFilesystemPath)) {
        return {
          homeDisplayPath: '/',
          homeFilesystemPath: rootFilesystemPath,
          rootFilesystemPath,
        };
      }
    }
  }

  return null;
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

    for (const distroName of distroNames) {
      const discovered = await discoverWslPathInfoFromDistroName(distroName);
      if (discovered) return discovered;
    }
  }

  return null;
}

async function discoverWslPathInfoFromDistroName(distroName: string): Promise<WslPathInfo | null> {
  const namespaceRoots = ['\\\\wsl.localhost', '\\\\wsl$'];
  for (const namespaceRoot of namespaceRoots) {
    const rootFilesystemPath = path.win32.join(namespaceRoot, distroName);
    if (!(await directoryExists(rootFilesystemPath))) continue;

    const homeCandidate = await resolveBestWslHomeCandidate(rootFilesystemPath);
    if (homeCandidate) {
      return {
        homeDisplayPath: homeCandidate.displayPath,
        homeFilesystemPath: homeCandidate.filesystemPath,
        rootFilesystemPath,
      };
    }

    return {
      homeDisplayPath: '/',
      homeFilesystemPath: rootFilesystemPath,
      rootFilesystemPath,
    };
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

async function resolveBestWslHomeCandidate(
  rootFilesystemPath: string,
): Promise<{ displayPath: string; filesystemPath: string } | null> {
  const homeRoot = path.win32.join(rootFilesystemPath, 'home');
  const usernameCandidates = getWindowsUsernameCandidates();

  for (const username of usernameCandidates) {
    const filesystemPath = path.win32.join(homeRoot, username);
    if (await directoryExists(filesystemPath)) {
      return {
        displayPath: `/home/${username}`,
        filesystemPath,
      };
    }
  }

  try {
    const homeEntries = await readdir(homeRoot, { withFileTypes: true });
    const homeDirectories = homeEntries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((name) => name.trim().length > 0);

    if (homeDirectories.length === 1) {
      const username = homeDirectories[0];
      return {
        displayPath: `/home/${username}`,
        filesystemPath: path.win32.join(homeRoot, username),
      };
    }
  } catch {
    // Fall back to /home or /.
  }

  if (await directoryExists(homeRoot)) {
    return {
      displayPath: '/home',
      filesystemPath: homeRoot,
    };
  }

  return null;
}

function getWindowsUsernameCandidates(): string[] {
  const candidates = [
    process.env.USERNAME,
    process.env.USERPROFILE ? path.win32.basename(process.env.USERPROFILE) : null,
    isWindowsDrivePath(homedir()) ? path.win32.basename(homedir()) : null,
  ];

  return [...new Set(candidates.filter((value): value is string => Boolean(value)))];
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
