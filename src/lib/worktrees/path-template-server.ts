import path from 'path';
import { buildManagedWorktreeProjectSlug, normalizeManagedWorktreeSlug } from './naming';
import {
  windowsDrivePathToWslMountPath,
  wslMountPathToWindowsDrivePath,
} from '../filesystem/path-environment';
import type { AgentEnvironment } from '../settings/types';

export const MANAGED_WORKTREE_PATH_TEMPLATE_TOKENS = [
  'projectPath',
  'projectParent',
  'projectName',
  'projectSlug',
  'branchName',
  'branchSlug',
] as const;

type ManagedWorktreePathTemplateToken = typeof MANAGED_WORKTREE_PATH_TEMPLATE_TOKENS[number];

const TOKEN_SET = new Set<string>(MANAGED_WORKTREE_PATH_TEMPLATE_TOKENS);

export class ManagedWorktreePathTemplateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ManagedWorktreePathTemplateError';
  }
}

export interface ManagedWorktreePathTemplateContext {
  agentEnvironment?: AgentEnvironment;
  branchName: string;
  projectDir: string;
}

export function resolveManagedWorktreePathTemplate(
  template: string,
  context: ManagedWorktreePathTemplateContext,
): string {
  const normalizedTemplate = template.trim();
  if (!normalizedTemplate) {
    throw new ManagedWorktreePathTemplateError('Worktree path template is empty');
  }

  validateTemplateSyntax(normalizedTemplate);
  if (!normalizedTemplate.includes('{branchName}') && !normalizedTemplate.includes('{branchSlug}')) {
    throw new ManagedWorktreePathTemplateError(
      'Worktree path template must include {branchName} or {branchSlug}',
    );
  }

  const projectPathModule = getPathModule(context.projectDir);
  const normalizedProjectDir = trimTrailingSeparators(projectPathModule.normalize(context.projectDir));
  const projectParent = projectPathModule.dirname(normalizedProjectDir);
  const projectName = projectPathModule.basename(normalizedProjectDir);
  const values: Record<ManagedWorktreePathTemplateToken, string> = {
    projectPath: normalizedProjectDir,
    projectParent,
    projectName,
    projectSlug: buildManagedWorktreeProjectSlug(context.projectDir),
    branchName: context.branchName,
    branchSlug: normalizeManagedWorktreeSlug(context.branchName),
  };

  const expanded = normalizedTemplate.replace(/\{([^{}]+)\}/g, (_match, token: string) => {
    if (!TOKEN_SET.has(token)) {
      throw new ManagedWorktreePathTemplateError(`Unsupported worktree path token: {${token}}`);
    }
    return values[token as ManagedWorktreePathTemplateToken];
  });

  const pathModule = getPathModule(expanded);
  const resolvedPath = pathModule.normalize(expanded);
  const normalizedWorktreePath = normalizeResolvedWorktreePathForProject(
    resolvedPath,
    normalizedProjectDir,
    context.agentEnvironment,
  );
  validateResolvedWorktreePath(normalizedWorktreePath, normalizedProjectDir);
  return normalizedWorktreePath;
}

function validateTemplateSyntax(template: string): void {
  const bracePattern = /\{([^{}]+)\}/g;
  let match: RegExpExecArray | null;
  const seenTokens: string[] = [];
  while ((match = bracePattern.exec(template)) !== null) {
    seenTokens.push(match[1]);
  }

  if (template.includes('{') || template.includes('}')) {
    const withoutKnownTokens = template.replace(bracePattern, '');
    if (withoutKnownTokens.includes('{') || withoutKnownTokens.includes('}')) {
      throw new ManagedWorktreePathTemplateError('Worktree path template has an invalid token');
    }
  }

  for (const token of seenTokens) {
    if (!TOKEN_SET.has(token)) {
      throw new ManagedWorktreePathTemplateError(`Unsupported worktree path token: {${token}}`);
    }
  }
}

function validateResolvedWorktreePath(worktreePath: string, projectDir: string): void {
  if (!isAbsoluteFilesystemPath(worktreePath)) {
    throw new ManagedWorktreePathTemplateError(
      'Worktree path template must resolve to an absolute path',
    );
  }

  const worktreeIdentity = getFilesystemPathIdentity(worktreePath);
  const projectIdentity = getFilesystemPathIdentity(projectDir);
  if (!isSameFilesystem(worktreeIdentity, projectIdentity)) {
    throw new ManagedWorktreePathTemplateError(
      'Worktree path template must resolve in the same filesystem as the project',
    );
  }

  if (worktreeIdentity.comparablePath === projectIdentity.comparablePath) {
    throw new ManagedWorktreePathTemplateError(
      'Worktree path template resolves to the source project directory',
    );
  }

  if (isComparablePathInside(projectIdentity.comparablePath, worktreeIdentity.comparablePath)) {
    throw new ManagedWorktreePathTemplateError(
      'Worktree path template resolves to an ancestor of the source project',
    );
  }
}

type FilesystemPathKind = 'posix' | 'windows-drive' | 'windows-unc' | 'wsl-unc';

interface FilesystemPathIdentity {
  comparablePath: string;
  kind: FilesystemPathKind;
  rootKey: string;
}

interface WindowsDrivePathIdentity extends FilesystemPathIdentity {
  drive: string;
  kind: 'windows-drive';
  windowsPath: string;
  wslMountPath: string;
}

function normalizeResolvedWorktreePathForProject(
  worktreePath: string,
  projectDir: string,
  agentEnvironment?: AgentEnvironment,
): string {
  const wslWorktreePath = normalizeWslResolvedWorktreePathForProject(
    worktreePath,
    projectDir,
    agentEnvironment,
  );
  if (wslWorktreePath) {
    return wslWorktreePath;
  }

  const worktreeIdentity = getWindowsDrivePathIdentity(worktreePath);
  const projectIdentity = getWindowsDrivePathIdentity(projectDir);
  if (!worktreeIdentity || !projectIdentity) {
    return worktreePath;
  }

  if (!isSameFilesystem(worktreeIdentity, projectIdentity)) {
    return worktreePath;
  }

  if (agentEnvironment === 'wsl') {
    return worktreePath;
  }

  return isWslMountedWindowsDrivePath(projectDir)
    ? worktreeIdentity.wslMountPath
    : worktreeIdentity.windowsPath;
}

interface WslTemplatePathIdentity {
  distro: string | null;
  pathStyle: 'posix' | 'unc';
  posixPath: string;
  uncDistro?: string;
}

function normalizeWslResolvedWorktreePathForProject(
  worktreePath: string,
  projectDir: string,
  agentEnvironment?: AgentEnvironment,
): string | null {
  if (agentEnvironment !== 'wsl') {
    return null;
  }

  const worktreeIdentity = getWslTemplatePathIdentity(worktreePath, agentEnvironment);
  const projectIdentity = getWslTemplatePathIdentity(projectDir, agentEnvironment);
  if (!worktreeIdentity || !projectIdentity) {
    return null;
  }

  if (!isSameWslTemplateFilesystem(worktreeIdentity, projectIdentity)) {
    return null;
  }

  if (projectIdentity.pathStyle === 'unc') {
    return buildWslUncPathForTemplate(
      projectIdentity.uncDistro
        ?? worktreeIdentity.uncDistro
        ?? projectIdentity.distro
        ?? worktreeIdentity.distro,
      worktreeIdentity.posixPath,
    ) ?? worktreePath;
  }

  return worktreeIdentity.posixPath;
}

function getWslTemplatePathIdentity(
  filesystemPath: string,
  agentEnvironment?: AgentEnvironment,
): WslTemplatePathIdentity | null {
  const uncIdentity = getWslUncTemplatePathIdentity(filesystemPath);
  if (uncIdentity) {
    return uncIdentity;
  }

  if (
    agentEnvironment !== 'wsl'
    || !filesystemPath.startsWith('/')
    || wslMountPathToWindowsDrivePath(filesystemPath)
  ) {
    return null;
  }

  return {
    distro: getCurrentWslDistroName(),
    pathStyle: 'posix',
    posixPath: normalizeWslPosixPath(filesystemPath),
  };
}

function getWslUncTemplatePathIdentity(filesystemPath: string): WslTemplatePathIdentity | null {
  const normalizedPath = path.win32.normalize(filesystemPath.replace(/\//g, '\\'));
  const match = normalizedPath.match(/^\\\\(?:wsl\.localhost|wsl\$)\\([^\\]+)(?:\\(.*))?$/i);
  if (!match) return null;

  const rest = normalizeComparablePathSegments(match[2] ?? '');
  return {
    distro: match[1].toLowerCase(),
    pathStyle: 'unc',
    posixPath: rest ? `/${rest}` : '/',
    uncDistro: match[1],
  };
}

function isSameWslTemplateFilesystem(
  left: WslTemplatePathIdentity,
  right: WslTemplatePathIdentity,
): boolean {
  if (!left.distro || !right.distro) {
    return true;
  }
  return left.distro === right.distro;
}

function buildWslUncPathForTemplate(
  distro: string | null,
  posixPath: string,
): string | null {
  if (!distro) return null;

  return path.win32.join(
    `\\\\wsl.localhost\\${distro}`,
    ...normalizeWslPosixPath(posixPath).split('/').filter(Boolean),
  );
}

function normalizeWslPosixPath(filesystemPath: string): string {
  return trimTrailingSeparators(path.posix.normalize(filesystemPath));
}

function getCurrentWslDistroName(): string | null {
  return process.env.WSL_DISTRO_NAME?.trim().toLowerCase() || null;
}

function getFilesystemPathIdentity(filesystemPath: string): FilesystemPathIdentity {
  return (
    getWindowsDrivePathIdentity(filesystemPath)
    ?? getWslUncPathIdentity(filesystemPath)
    ?? getWindowsUncPathIdentity(filesystemPath)
    ?? getPosixPathIdentity(filesystemPath)
  );
}

function getWindowsDrivePathIdentity(filesystemPath: string): WindowsDrivePathIdentity | null {
  const fromWindowsPath = getWindowsDrivePathFromWindowsStyle(filesystemPath);
  if (fromWindowsPath) return fromWindowsPath;

  const windowsPath = wslMountPathToWindowsDrivePath(filesystemPath);
  if (!windowsPath) return null;

  return buildWindowsDrivePathIdentity(windowsPath);
}

function getWindowsDrivePathFromWindowsStyle(
  filesystemPath: string,
): WindowsDrivePathIdentity | null {
  if (!/^[a-zA-Z]:[\\/]/.test(filesystemPath) && !/^[a-zA-Z]:$/.test(filesystemPath)) {
    return null;
  }

  return buildWindowsDrivePathIdentity(path.win32.normalize(filesystemPath));
}

function buildWindowsDrivePathIdentity(windowsPath: string): WindowsDrivePathIdentity | null {
  const normalizedWindowsPath = path.win32.normalize(windowsPath);
  const match = normalizedWindowsPath.match(/^([a-zA-Z]):[\\/]?(.*)$/);
  if (!match) return null;

  const drive = match[1].toLowerCase();
  const rest = normalizeComparablePathSegments(match[2]);
  const canonicalWindowsPath = rest
    ? `${drive.toUpperCase()}:\\${rest.replace(/\//g, '\\')}`
    : `${drive.toUpperCase()}:\\`;
  const wslMountPath = windowsDrivePathToWslMountPath(canonicalWindowsPath);
  if (!wslMountPath) return null;

  return {
    comparablePath: rest ? `/${rest.toLowerCase()}` : '/',
    drive,
    kind: 'windows-drive',
    rootKey: `windows-drive:${drive}`,
    windowsPath: canonicalWindowsPath,
    wslMountPath,
  };
}

function getWslUncPathIdentity(filesystemPath: string): FilesystemPathIdentity | null {
  const normalizedPath = path.win32.normalize(filesystemPath.replace(/\//g, '\\'));
  const match = normalizedPath.match(/^\\\\(?:wsl\.localhost|wsl\$)\\([^\\]+)(?:\\(.*))?$/i);
  if (!match) return null;

  const distro = match[1].toLowerCase();
  const rest = normalizeComparablePathSegments(match[2] ?? '');
  return {
    comparablePath: rest ? `/${rest}` : '/',
    kind: 'wsl-unc',
    rootKey: `wsl-unc:${distro}`,
  };
}

function getWindowsUncPathIdentity(filesystemPath: string): FilesystemPathIdentity | null {
  if (!filesystemPath.startsWith('\\\\') && !filesystemPath.startsWith('//')) {
    return null;
  }

  const normalizedPath = path.win32.normalize(filesystemPath.replace(/\//g, '\\'));
  const match = normalizedPath.match(/^\\\\([^\\]+)\\([^\\]+)(?:\\(.*))?$/);
  if (!match) return null;

  const server = match[1].toLowerCase();
  const share = match[2].toLowerCase();
  const rest = normalizeComparablePathSegments(match[3] ?? '').toLowerCase();
  return {
    comparablePath: rest ? `/${rest}` : '/',
    kind: 'windows-unc',
    rootKey: `windows-unc:${server}/${share}`,
  };
}

function getPosixPathIdentity(filesystemPath: string): FilesystemPathIdentity {
  const normalizedPath = trimTrailingSeparators(path.posix.normalize(filesystemPath));
  return {
    comparablePath: normalizedPath,
    kind: 'posix',
    rootKey: 'posix',
  };
}

function isSameFilesystem(
  left: FilesystemPathIdentity,
  right: FilesystemPathIdentity,
): boolean {
  return left.kind === right.kind && left.rootKey === right.rootKey;
}

function isComparablePathInside(candidate: string, parent: string): boolean {
  if (candidate === parent) return false;
  if (parent === '/') return candidate.startsWith('/');
  return candidate.startsWith(`${parent}/`);
}

function normalizeComparablePathSegments(value: string): string {
  return value
    .replace(/[\\/]+/g, '/')
    .replace(/^\/+|\/+$/g, '');
}

function isWslMountedWindowsDrivePath(filesystemPath: string): boolean {
  return wslMountPathToWindowsDrivePath(filesystemPath) !== null;
}

function trimTrailingSeparators(candidate: string): string {
  if (/^[a-zA-Z]:[\\/]*$/.test(candidate)) {
    return candidate.replace(/[\\/]+$/g, '\\');
  }
  if (/^[/\\]+$/.test(candidate)) {
    return candidate.slice(0, 1);
  }
  return candidate.replace(/[\\/]+$/g, '');
}

function getPathModule(filesystemPath: string): typeof path.win32 | typeof path.posix {
  return isWindowsStylePath(filesystemPath) ? path.win32 : path.posix;
}

function isAbsoluteFilesystemPath(candidate: string): boolean {
  return path.isAbsolute(candidate) || path.win32.isAbsolute(candidate);
}

function isWindowsStylePath(filesystemPath: string): boolean {
  return (
    /^[a-zA-Z]:[\\/]/.test(filesystemPath)
    || /^[a-zA-Z]:$/.test(filesystemPath)
    || filesystemPath.startsWith('\\\\')
    || filesystemPath.startsWith('//')
  );
}
