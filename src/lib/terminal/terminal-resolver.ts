import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { getProject, getVisibleProjects } from '@/lib/db/projects';
import { getSession } from '@/lib/db/sessions';
import { getRuntimePlatform } from '@/lib/system/runtime-platform';
import type { TerminalCwdResolution, TerminalResolvedShell, TerminalShellKind } from './types';

export function resolveTerminalCwd(candidate?: string | null): string {
  if (candidate) {
    try {
      const stat = fs.statSync(candidate);
      if (stat.isDirectory()) {
        return candidate;
      }
    } catch {
      // Fall through to home directory.
    }
  }

  return os.homedir();
}

let cachedWindowsHostedWslRoot: string | null | undefined;

function resolveExistingDirectory(candidate: string, allowedRoots: string[] = []): string | null {
  for (const candidatePath of buildDirectoryResolutionCandidates(candidate, allowedRoots)) {
    const existingDirectory = resolveExistingDirectoryCandidate(candidatePath);
    if (existingDirectory) return existingDirectory;
  }

  return null;
}

function resolveExistingDirectoryCandidate(candidate: string): string | null {
  try {
    const resolved = isWindowsStylePath(candidate)
      ? path.win32.resolve(candidate)
      : path.resolve(candidate);
    const stat = fs.statSync(resolved);
    return stat.isDirectory() ? resolved : null;
  } catch {
    return null;
  }
}

function normalizeForComparison(value: string): string {
  const wslPath = toWslPath(value);
  if (wslPath) {
    return path.posix.resolve(wslPath);
  }

  const normalized = path.resolve(value);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function isSameOrChildPath(candidate: string, allowedRoot: string): boolean {
  const normalizedCandidate = normalizeForComparison(candidate);
  const normalizedRoot = normalizeForComparison(allowedRoot);
  if (normalizedCandidate === normalizedRoot) return true;
  const pathModule = normalizedCandidate.startsWith('/') && normalizedRoot.startsWith('/')
    ? path.posix
    : path;
  const relative = pathModule.relative(normalizedRoot, normalizedCandidate);
  return Boolean(relative) && !relative.startsWith('..') && !pathModule.isAbsolute(relative);
}

function addAllowedRoot(allowedRoots: string[], seenRoots: Set<string>, root?: string | null): void {
  const normalizedRoot = root?.trim();
  if (!normalizedRoot || seenRoots.has(normalizedRoot)) return;
  seenRoots.add(normalizedRoot);
  allowedRoots.push(normalizedRoot);
}

function resolveFirstExistingAllowedRoot(allowedRoots: string[]): string | null {
  for (const root of allowedRoots) {
    const existingRoot = resolveExistingDirectory(root, allowedRoots);
    if (existingRoot) return existingRoot;
  }

  return null;
}

function isWindowsDrivePath(value: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(value) || /^[a-zA-Z]:$/.test(value);
}

function isWindowsHostedWslPath(value: string): boolean {
  return /^\\\\(?:wsl\.localhost|wsl\$)\\/i.test(value)
    || /^\/\/(?:wsl\.localhost|wsl\$)\//i.test(value);
}

function isWindowsStylePath(value: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(value)
    || isWindowsHostedWslPath(value)
    || value.startsWith('\\\\')
    || value.startsWith('//');
}

function buildDirectoryResolutionCandidates(candidate: string, allowedRoots: string[]): string[] {
  const candidates = [candidate];
  if (getRuntimePlatform() !== 'win32') {
    return candidates;
  }

  if (candidate.startsWith('//')) {
    candidates.push(candidate.replace(/\//g, '\\'));
  }

  if (candidate.startsWith('/') && !candidate.startsWith('//')) {
    for (const root of getWindowsHostedWslReferenceRoots(allowedRoots)) {
      candidates.push(toWindowsHostedWslPath(candidate, root));
    }
  }

  return [...new Set(candidates)];
}

function getWindowsHostedWslReferenceRoots(values: string[]): string[] {
  const roots = new Set<string>();
  for (const value of values) {
    const root = getWindowsHostedWslRoot(value);
    if (root) roots.add(root);
  }

  const defaultRoot = getWindowsHostedWslDefaultRoot();
  if (defaultRoot) roots.add(defaultRoot);

  return [...roots];
}

function getWindowsHostedWslRoot(value: string | null | undefined): string | null {
  const normalized = value?.replace(/\//g, '\\');
  if (!normalized) return null;
  const match = normalized.match(/^(\\\\(?:wsl\.localhost|wsl\$)\\[^\\]+)(?:\\|$)/i);
  return match ? path.win32.normalize(match[1]) : null;
}

function getWindowsHostedWslDefaultRoot(): string | null {
  if (getRuntimePlatform() !== 'win32') return null;
  if (cachedWindowsHostedWslRoot !== undefined) {
    return cachedWindowsHostedWslRoot;
  }

  const envDistro = process.env.WSL_DISTRO_NAME?.trim();
  if (envDistro) {
    cachedWindowsHostedWslRoot = `\\\\wsl.localhost\\${envDistro}`;
    return cachedWindowsHostedWslRoot;
  }

  try {
    const distro = execFileSync(
      'wsl.exe',
      ['-e', 'sh', '-c', 'printf "%s" "${WSL_DISTRO_NAME:-}"'],
      { encoding: 'utf8', timeout: 2000, windowsHide: true },
    ).trim();
    cachedWindowsHostedWslRoot = distro ? `\\\\wsl.localhost\\${distro}` : null;
  } catch {
    cachedWindowsHostedWslRoot = null;
  }

  return cachedWindowsHostedWslRoot;
}

function toWindowsHostedWslPath(displayPath: string, wslRoot: string): string {
  const normalizedDisplayPath = path.posix.normalize(displayPath);
  if (normalizedDisplayPath === '/') return wslRoot;
  return path.win32.join(
    wslRoot,
    ...normalizedDisplayPath.split('/').filter(Boolean),
  );
}

function toWslPath(value: string): string | null {
  const driveMatch = value.match(/^([a-zA-Z]):[\\/]*(.*)$/);
  if (driveMatch) {
    const drive = driveMatch[1].toLowerCase();
    const rest = driveMatch[2].replace(/[\\/]+/g, '/').replace(/^\/+/, '');
    return rest ? `/mnt/${drive}/${rest}` : `/mnt/${drive}`;
  }

  const uncMatch = value.match(/^\\\\(?:wsl\.localhost|wsl\$)\\([^\\]+)\\?(.*)$/i);
  if (uncMatch) {
    const rest = uncMatch[2].replace(/\\/g, '/').replace(/^\/+/, '');
    return rest ? `/${rest}` : '/';
  }

  const slashUncMatch = value.match(/^\/\/(?:wsl\.localhost|wsl\$)\/([^/]+)\/?(.*)$/i);
  if (slashUncMatch) {
    const rest = slashUncMatch[2].replace(/^\/+/, '');
    return rest ? `/${rest}` : '/';
  }

  if (value.startsWith('/')) {
    return path.posix.normalize(value);
  }

  return null;
}

function resolveWindowsProcessCwd(env: NodeJS.ProcessEnv): string {
  const userProfile = env.USERPROFILE?.trim();
  if (userProfile && isWindowsDrivePath(userProfile)) {
    return path.win32.normalize(userProfile);
  }

  const home = os.homedir();
  if (isWindowsDrivePath(home)) {
    return path.win32.normalize(home);
  }

  const windowsRoot = env.SystemRoot?.trim() || env.windir?.trim();
  if (windowsRoot && isWindowsDrivePath(windowsRoot)) {
    return path.win32.join(windowsRoot, 'System32');
  }

  return 'C:\\';
}

function resolveWindowsNativeTerminalCwd(cwd: string, env: NodeJS.ProcessEnv): string {
  if (isWindowsHostedWslPath(cwd)) {
    return resolveWindowsProcessCwd(env);
  }

  return cwd;
}

function quoteBashArg(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function buildWslTerminalScript(cwd: string): string {
  return [
    `cd -- ${quoteBashArg(cwd)} 2>/dev/null || cd ~`,
    'shell="${SHELL:-}"',
    'if [ -z "$shell" ] || [ ! -x "$shell" ]; then shell="$(getent passwd "$(id -un)" 2>/dev/null | cut -d: -f7)"; fi',
    'if [ -z "$shell" ] || [ ! -x "$shell" ]; then shell="$(command -v bash 2>/dev/null || command -v sh)"; fi',
    'exec "$shell" -i',
  ].join('; ');
}

export function resolveAllowedTerminalCwd(options: {
  cwd?: string | null;
  sessionId?: string | null;
}): TerminalCwdResolution {
  const requestedCwd = options.cwd?.trim();
  const allowedRoots: string[] = [];
  const seenRoots = new Set<string>();

  const session = options.sessionId ? getSession(options.sessionId) : null;
  if (session?.project_id) {
    addAllowedRoot(allowedRoots, seenRoots, getProject(session.project_id)?.decoded_path);
  }

  for (const project of getVisibleProjects()) {
    addAllowedRoot(allowedRoots, seenRoots, project.decoded_path);
  }

  addAllowedRoot(allowedRoots, seenRoots, session?.work_dir);

  if (allowedRoots.length === 0) {
    return { ok: false, message: 'No project is available for terminal startup.' };
  }

  if (!requestedCwd) {
    const fallbackCwd = resolveFirstExistingAllowedRoot(allowedRoots);
    if (fallbackCwd) {
      return { ok: true, cwd: fallbackCwd };
    }

    return { ok: false, message: 'No registered project directory exists on this server.' };
  }

  const resolvedCandidate = resolveExistingDirectory(requestedCwd, allowedRoots);
  if (!resolvedCandidate) {
    const fallbackCwd = resolveFirstExistingAllowedRoot(allowedRoots);
    if (fallbackCwd) {
      return { ok: true, cwd: fallbackCwd };
    }

    return { ok: false, message: 'Terminal cwd does not exist or is not a directory.' };
  }

  for (const root of allowedRoots) {
    if (isSameOrChildPath(resolvedCandidate, root)) {
      return { ok: true, cwd: resolvedCandidate };
    }
  }

  return {
    ok: false,
    message: 'Terminal cwd must be inside a registered project or active worktree.',
  };
}

export function resolveTerminalShell(options: {
  cwd?: string | null;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  shellKind?: TerminalShellKind;
}): TerminalResolvedShell {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const shellKind = options.shellKind ?? 'default';
  const cwd = resolveTerminalCwd(options.cwd);

  if (shellKind === 'wsl' && platform === 'win32') {
    const wslCwd = toWslPath(cwd) ?? '~';
    return {
      command: 'wsl.exe',
      args: ['-e', 'sh', '-c', buildWslTerminalScript(wslCwd)],
      cwd: resolveWindowsProcessCwd(env),
      displayCwd: wslCwd,
    };
  }

  if (platform === 'win32') {
    const windowsCwd = resolveWindowsNativeTerminalCwd(cwd, env);
    if (shellKind === 'cmd') {
      return { command: 'cmd.exe', args: [], cwd: windowsCwd };
    }

    return {
      command: env.ComSpec?.toLowerCase().includes('powershell')
        ? env.ComSpec
        : 'powershell.exe',
      args: ['-NoLogo'],
      cwd: windowsCwd,
    };
  }

  const command = env.SHELL || (platform === 'darwin' ? '/bin/zsh' : '/bin/bash');
  const args = platform === 'darwin' ? ['-l'] : [];

  return { command, args, cwd };
}
