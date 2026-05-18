import path from 'path';
import { getRuntimePlatform } from '@/lib/system/runtime-platform';
import { resolveBrowsePath } from './path-environment';

export function isWindowsStyleFilesystemPath(filesystemPath: string): boolean {
  return (
    /^[a-zA-Z]:[\\/]/.test(filesystemPath)
    || /^[a-zA-Z]:$/.test(filesystemPath)
    || filesystemPath.startsWith('\\\\')
    || filesystemPath.startsWith('//')
  );
}

export function getFilesystemPathModule(
  filesystemPath: string,
): typeof path.win32 | typeof path.posix {
  return isWindowsStyleFilesystemPath(filesystemPath) ? path.win32 : path.posix;
}

export function isAbsoluteFilesystemPath(filesystemPath: string): boolean {
  return path.posix.isAbsolute(filesystemPath) || path.win32.isAbsolute(filesystemPath);
}

export function resolveHostPathWithStyle(filesystemPath: string): string {
  return getFilesystemPathModule(filesystemPath).resolve(filesystemPath);
}

export async function resolvePathForHostFilesystem(filesystemPath: string): Promise<string> {
  const trimmed = filesystemPath.trim();

  if (getRuntimePlatform() === 'win32' && trimmed.startsWith('/')) {
    try {
      const resolved = await resolveBrowsePath(trimmed, 'wsl');
      return resolved.filesystemPath;
    } catch {
      // Fall through to style-local resolution. Callers still handle missing paths.
    }
  }

  return resolveHostPathWithStyle(trimmed);
}
