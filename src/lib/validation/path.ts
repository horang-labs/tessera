/**
 * Path validation utilities for API route handlers.
 * Prevents path traversal attacks on project directory parameters.
 */

/**
 * Validate a project directory value (absolute path or legacy encoded dir).
 * Returns false if the value contains path traversal sequences.
 */
export function validateEncodedPath(value: string): boolean {
  if (!value || typeof value !== 'string') return false;
  if (value.includes('\0')) return false;

  const pathSegments = value
    .replace(/\\/g, '/')
    .split('/')
    .filter(Boolean);

  if (pathSegments.some((segment) => segment === '..')) return false;

  return true;
}

/** Codex thread ID format: alphanumeric, underscore, hyphen, 1-128 chars */
export const CODEX_THREAD_ID_RE = /^[a-zA-Z0-9_-]{1,128}$/;
