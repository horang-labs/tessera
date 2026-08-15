import {
  parseIgnoredFileCandidates,
  type IgnoredFileCandidate,
} from './ignored-file-candidates';
import type { GitRunner } from '@/lib/worktrees/git-runner';

/**
 * How many candidates a checklist is willing to show.
 *
 * The collapsed scan of an ordinary repository returns a couple of dozen, so
 * reaching this means the project ignores files across a great many
 * directories — a list nobody would read anyway, and one long enough to make
 * the panel unusable.
 */
const IGNORED_FILE_SCAN_LIMIT = 500;

export interface IgnoredFileScan {
  candidates: IgnoredFileCandidate[];
  /** True when the scan found more than the limit and the rest were dropped. */
  truncated: boolean;
  /** How many the checkout ignores, whether or not they all came back. */
  total: number;
}

/**
 * Ask git what it ignores in a checkout, collapsed at directory level.
 *
 * Collapsing is what makes the answer readable: uncollapsed, a repository with
 * its dependencies installed returns tens of thousands of paths, nearly all of
 * them inside one or two directories nobody wants copied.
 */
export async function scanIgnoredFiles(
  projectDir: string,
  runGit: GitRunner,
): Promise<IgnoredFileScan> {
  const { stdout } = await runGit([
    '-C',
    projectDir,
    'ls-files',
    // NUL-separated, because a filename may hold anything a line ending is not.
    '-z',
    '--others',
    '--ignored',
    '--exclude-standard',
    // Report a wholly ignored directory as itself rather than its contents.
    '--directory',
    '--no-empty-directory',
  ]);

  const candidates = parseIgnoredFileCandidates(stdout);
  return {
    candidates: candidates.slice(0, IGNORED_FILE_SCAN_LIMIT),
    truncated: candidates.length > IGNORED_FILE_SCAN_LIMIT,
    total: candidates.length,
  };
}
