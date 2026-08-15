import type { GhRunner } from '@/lib/github/gh-cli';

export const TESSERA_REPOSITORY_SLUG = 'horang-labs/tessera';
export const TESSERA_REPOSITORY_URL = `https://github.com/${TESSERA_REPOSITORY_SLUG}`;

export type RepositoryStarStatus = 'starred' | 'unstarred' | 'unavailable';

const NOT_FOUND_STATUS = /\bHTTP\s+404\b/i;
const STARRED_STATUS = /\bHTTP\/[\d.]+\s+(?:200|204)\b/i;

/**
 * Ask GitHub itself instead of caching this locally. A failed probe is not the
 * same as "not starred": gh may be absent, signed out, offline, or missing the
 * required scope, and the renderer can still offer the repository web page.
 */
export async function getTesseraRepositoryStarStatus(
  runGh: GhRunner,
): Promise<RepositoryStarStatus> {
  const result = await runGh([
    'api',
    '--hostname',
    'github.com',
    '--include',
    `user/starred/${TESSERA_REPOSITORY_SLUG}`,
  ]);

  const output = `${result.stdout}\n${result.stderr}`;
  if (result.exitCode === 0 && STARRED_STATUS.test(output)) return 'starred';
  return NOT_FOUND_STATUS.test(output) ? 'unstarred' : 'unavailable';
}

/** GitHub's PUT star endpoint is idempotent, so no local locking is needed. */
export async function starTesseraRepository(runGh: GhRunner): Promise<boolean> {
  const result = await runGh([
    'api',
    '--hostname',
    'github.com',
    '--method',
    'PUT',
    `user/starred/${TESSERA_REPOSITORY_SLUG}`,
  ]);

  return result.exitCode === 0;
}
