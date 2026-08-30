import type {
  GitAction,
  GitActionRejectionCode,
} from './git-actions';

export function describeGitActionRejection(
  code: GitActionRejectionCode,
): { code: string; status: number } {
  if (code === 'file_not_in_change_set') {
    return { code: 'invalid_file_path', status: 404 };
  }
  if (
    code === 'detached_head'
    || code === 'no_remote'
    || code === 'no_upstream'
    || code === 'not_github_remote'
    || code === 'no_conflict_in_progress'
    || code === 'not_revertible'
  ) {
    return { code, status: 409 };
  }
  return { code: 'invalid_request', status: 400 };
}

export function parseGitActionBody(
  body: unknown,
): { action: GitAction } | { message: string } {
  if (typeof body !== 'object' || body === null) {
    return { message: 'A git action body is required' };
  }

  const { action, message, files } = body as {
    action?: unknown;
    message?: unknown;
    files?: unknown;
  };
  if (
    action === 'push'
    || action === 'pull'
    || action === 'create_pr'
    || action === 'abort'
  ) {
    return { action: { action } };
  }
  if (action === 'revert') {
    if (!Array.isArray(files) || files.some((file) => typeof file !== 'string')) {
      return { message: 'A list of file paths is required' };
    }
    return { action: { action: 'revert', files: files as string[] } };
  }
  if (action !== 'commit') {
    return { message: `Unsupported git action: ${String(action)}` };
  }
  if (typeof message !== 'string') {
    return { message: 'A commit message is required' };
  }
  if (!Array.isArray(files) || files.some((file) => typeof file !== 'string')) {
    return { message: 'A list of file paths is required' };
  }
  return { action: { action: 'commit', message, files: files as string[] } };
}
