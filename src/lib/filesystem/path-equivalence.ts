/**
 * Produce a browser-safe comparison key for paths that may cross the
 * Windows-server / WSL-agent boundary. This module deliberately avoids Node
 * path and filesystem APIs because Project state is also updated in the
 * renderer.
 */
export function crossEnvironmentFilesystemPathKey(filesystemPath: string): string {
  const slashPath = filesystemPath.trim().replace(/\\/g, '/');
  const wslUncMatch = slashPath.match(
    /^\/\/(?:wsl\.localhost|wsl\$)\/[^/]+(\/.*)?$/i,
  );
  if (wslUncMatch) {
    return `wsl:${normalizeAbsolutePath(wslUncMatch[1] ?? '/')}`;
  }

  const windowsDriveMatch = slashPath.match(/^([a-zA-Z]):(?:\/(.*))?$/);
  if (windowsDriveMatch) {
    return windowsDriveKey(windowsDriveMatch[1], windowsDriveMatch[2] ?? '');
  }

  const wslDriveMountMatch = slashPath.match(/^\/mnt\/([a-zA-Z])(?:\/(.*))?$/);
  if (wslDriveMountMatch) {
    return windowsDriveKey(wslDriveMountMatch[1], wslDriveMountMatch[2] ?? '');
  }

  if (slashPath.startsWith('/')) {
    return `wsl:${normalizeAbsolutePath(slashPath)}`;
  }

  return `relative:${slashPath}`;
}

export function areCrossEnvironmentFilesystemPathsEquivalent(
  left: string,
  right: string,
): boolean {
  return crossEnvironmentFilesystemPathKey(left)
    === crossEnvironmentFilesystemPathKey(right);
}

function windowsDriveKey(drive: string, rest: string): string {
  const normalizedRest = normalizePathSegments(rest).toLowerCase();
  return `windows:${drive.toLowerCase()}:/${normalizedRest}`;
}

function normalizeAbsolutePath(value: string): string {
  const normalized = normalizePathSegments(value);
  return normalized ? `/${normalized}` : '/';
}

function normalizePathSegments(value: string): string {
  const segments: string[] = [];
  for (const segment of value.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments.join('/');
}
