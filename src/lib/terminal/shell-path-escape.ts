/** Characters that never need quoting in a POSIX shell (same rule Orca uses). */
const POSIX_SAFE_PATH = /^[a-zA-Z0-9_./@:-]+$/;

function hasControlCharacters(path: string): boolean {
  for (let i = 0; i < path.length; i += 1) {
    const code = path.charCodeAt(i);
    if (code < 32 || code === 127) return true;
  }
  return false;
}

/**
 * Quote a file path for insertion into a POSIX shell prompt.
 * Safe paths pass through untouched; anything else is single-quoted with
 * embedded quotes escaped as '\''. Returns null for paths containing
 * control characters — those are never safe to write into a PTY.
 */
export function escapeShellPath(path: string): string | null {
  if (hasControlCharacters(path)) return null;
  if (POSIX_SAFE_PATH.test(path)) return path;
  return `'${path.replace(/'/g, "'\\''")}'`;
}
