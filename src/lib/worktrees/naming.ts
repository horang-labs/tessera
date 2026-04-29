export const MANAGED_WORKTREE_DISPLAY_ROOT = '~/.tessera/worktrees';

const MANAGED_WORKTREE_PROJECT_FALLBACK = 'project';
const MANAGED_WORKTREE_SLUG_PREVIEW = 'mmdd-xx';
const MAX_PROJECT_SLUG_LENGTH = 32;
const RANDOM_SUFFIX_ALPHABET_SIZE = 36;
const RANDOM_SUFFIX_LENGTH = 2;

function slugBranchPrefixSegment(segment: string): string {
  return segment
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function normalizeManagedWorktreeBranchPrefix(branchPrefix?: string | null): string {
  const segments = (branchPrefix ?? '')
    .trim()
    .replace(/\\/g, '/')
    .split('/')
    .map(slugBranchPrefixSegment)
    .filter(Boolean);

  return segments.length > 0 ? `${segments.join('/')}/` : '';
}

export function normalizeManagedWorktreeSlug(slug?: string | null): string {
  return (slug ?? '')
    .trim()
    .toLowerCase()
    .replace(/\\/g, '/')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export interface ManagedWorktreeSlugInputContext {
  data?: string | null;
  inputType?: string | null;
  isComposing?: boolean;
}

export function sanitizeManagedWorktreeSlugInput(
  nextValue: string,
  previousValue = '',
  inputContext?: ManagedWorktreeSlugInputContext
): string {
  const inputType = inputContext?.inputType?.toLowerCase() ?? '';
  if (
    inputContext?.isComposing ||
    inputType.includes('composition') ||
    (inputContext?.data && !isManagedWorktreeSlugInputAllowed(inputContext.data))
  ) {
    return previousValue;
  }

  const normalized = normalizeManagedWorktreeSlug(nextValue);
  if (nextValue.length > 0 && normalized.length === 0) {
    return previousValue;
  }
  return normalized;
}

export function isManagedWorktreeSlugInputAllowed(input: string): boolean {
  return /^[a-zA-Z0-9 _/-]*$/.test(input);
}

function extractProjectBasename(projectDir?: string | null): string {
  if (!projectDir) {
    return '';
  }

  const normalized = projectDir
    .replace(/\\/g, '/')
    .replace(/\/+$/g, '');

  if (!normalized) {
    return '';
  }

  const segments = normalized.split('/').filter(Boolean);
  return segments[segments.length - 1] ?? '';
}

export function buildManagedWorktreeProjectSlug(projectDir?: string | null): string {
  const basename = extractProjectBasename(projectDir);
  const slug = basename
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_PROJECT_SLUG_LENGTH)
    .replace(/-+$/g, '');

  return slug || MANAGED_WORKTREE_PROJECT_FALLBACK;
}

export function formatManagedWorktreeSlugDate(date = new Date()): string {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');

  return `${month}${day}`;
}

export function createManagedWorktreeRandomSuffix(): string {
  const max = RANDOM_SUFFIX_ALPHABET_SIZE ** RANDOM_SUFFIX_LENGTH;
  return Math.floor(Math.random() * max)
    .toString(RANDOM_SUFFIX_ALPHABET_SIZE)
    .padStart(RANDOM_SUFFIX_LENGTH, '0');
}

export function buildManagedWorktreeSlug(
  date = new Date(),
  randomSuffix = createManagedWorktreeRandomSuffix()
): string {
  return `${formatManagedWorktreeSlugDate(date)}-${normalizeManagedWorktreeSlug(randomSuffix)}`;
}

export function buildManagedWorktreeBranchName(
  slug: string,
  branchPrefix?: string | null
): string {
  const normalizedSlug = normalizeManagedWorktreeSlug(slug);
  const prefix = normalizeManagedWorktreeBranchPrefix(branchPrefix);
  return `${prefix}${normalizedSlug}`;
}

export function buildManagedWorktreeName(
  projectDir?: string | null,
  collisionIndex = 0,
  date = new Date(),
  branchPrefix?: string | null,
  baseSlug = buildManagedWorktreeSlug(date)
): string {
  void projectDir;
  const slug = normalizeManagedWorktreeSlug(baseSlug);
  const collisionSlug = collisionIndex > 0 ? `${slug}-${collisionIndex + 1}` : slug;

  return buildManagedWorktreeBranchName(collisionSlug, branchPrefix);
}

export function buildManagedWorktreeNamePreview(
  projectDir?: string | null,
  branchPrefix?: string | null,
  slug = MANAGED_WORKTREE_SLUG_PREVIEW
): string {
  void projectDir;

  return buildManagedWorktreeBranchName(slug, branchPrefix);
}

export function buildManagedWorktreeRelativePath(
  projectDir?: string | null,
  branchName?: string | null
): string {
  const projectSlug = buildManagedWorktreeProjectSlug(projectDir);
  const branchSegments = (branchName ?? '')
    .replace(/\\/g, '/')
    .split('/')
    .map(normalizeManagedWorktreeSlug)
    .filter(Boolean);

  return [projectSlug, ...branchSegments].join('/');
}

export function buildManagedWorktreePreviewPath(
  projectDir?: string | null,
  branchPrefix?: string | null,
  slug = MANAGED_WORKTREE_SLUG_PREVIEW
): string {
  const branchName = buildManagedWorktreeNamePreview(projectDir, branchPrefix, slug);
  return `${MANAGED_WORKTREE_DISPLAY_ROOT}/${buildManagedWorktreeRelativePath(projectDir, branchName)}`;
}
