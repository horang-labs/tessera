/**
 * What a scan of a project's ignored files offers as candidates for copying
 * into a new worktree, and which of them are worth copying by default.
 *
 * Everything here is pure. The caller asks git for the paths — collapsed at
 * directory level, because an uncollapsed scan of a repository with installed
 * dependencies runs to tens of thousands of entries — and this module turns
 * that answer into candidates and decides how each one arrives.
 */

/** One entry of a collapsed scan: a file, or a directory git ignores whole. */
export interface IgnoredFileCandidate {
  /** Relative to the original checkout, with no trailing slash. */
  path: string;
  isDirectory: boolean;
}

/**
 * What kind of thing a candidate is, as far as copying it is concerned.
 *
 * The first two are what a worktree is usually missing; the rest are what a
 * worktree is better off without, and are listed only so that someone who
 * knows they want one can say so.
 */
export type IgnoredFileCandidateKind =
  | 'configuration'
  | 'instructions'
  | 'dependencies'
  | 'buildOutput'
  | 'logs'
  | 'images'
  | 'unrecognised';

/** Directories holding what an agent or editor is told about the project. */
const INSTRUCTION_DIRECTORY_NAMES = new Set([
  '.claude',
  '.codex',
  '.cursor',
  '.gemini',
  '.opencode',
  '.vscode',
  '.windsurf',
]);

/** Files a project is instructed through, kept out of git because they are personal. */
const INSTRUCTION_FILE_NAMES = new Set([
  'agents.md',
  'claude.local.md',
  'claude.md',
  'codex.md',
  'gemini.md',
]);

/** Configuration whose name carries no extension to recognise it by. */
const CONFIGURATION_FILE_NAMES = new Set([
  '.editorconfig',
  '.envrc',
  '.nvmrc',
  '.npmrc',
  '.python-version',
  '.ruby-version',
  '.tool-versions',
  '.yarnrc',
]);

const CONFIGURATION_EXTENSIONS = new Set([
  'cfg',
  'conf',
  'env',
  'ini',
  'json',
  'json5',
  'jsonc',
  'properties',
  'toml',
  'yaml',
  'yml',
]);

const DEPENDENCY_DIRECTORY_NAMES = new Set([
  '.bundle',
  '.pnpm-store',
  '.venv',
  '.yarn',
  'bower_components',
  'node_modules',
  'site-packages',
  'venv',
  'vendor',
]);

const BUILD_OUTPUT_DIRECTORY_NAMES = new Set([
  '.cache',
  '.gradle',
  '.next',
  '.nuxt',
  '.output',
  '.parcel-cache',
  '.svelte-kit',
  '.turbo',
  '__pycache__',
  'build',
  'coverage',
  'dist',
  'out',
  'target',
]);

const LOG_DIRECTORY_NAMES = new Set(['log', 'logs']);

const IMAGE_EXTENSIONS = new Set([
  'avif',
  'bmp',
  'gif',
  'heic',
  'ico',
  'jpeg',
  'jpg',
  'png',
  'svg',
  'webp',
]);

/**
 * A newline, or anything else a terminal reads as an instruction rather than a
 * character. A copy command is one line of a script, so a path holding one
 * cannot be written as a candidate at all.
 */
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

/**
 * Read the paths out of a `git ls-files -z` answer.
 *
 * NUL separates the entries because a filename may hold anything else,
 * newlines included. A trailing separator, or the lack of one after the shared
 * git runner has trimmed the output, both leave the same list.
 *
 * A path holding a control character is dropped rather than offered: the
 * command that copies it would break the line it is written on, and a script
 * that cannot be read back is worse than a file left uncopied.
 */
export function parseIgnoredFileCandidates(raw: string): IgnoredFileCandidate[] {
  const seen = new Set<string>();
  const candidates: IgnoredFileCandidate[] = [];

  for (const entry of raw.split('\0')) {
    if (!entry) continue;
    const isDirectory = entry.endsWith('/');
    const path = isDirectory ? entry.slice(0, -1) : entry;
    if (!path || seen.has(path) || CONTROL_CHARACTERS.test(path)) continue;
    seen.add(path);
    candidates.push({ path, isDirectory });
  }

  return candidates;
}

/**
 * Decide what a candidate is, from its own name alone.
 *
 * Only the last segment is read: a project with several packages keeps its
 * `node_modules` and its `.env.local` at every level, and each means there
 * exactly what it means at the root.
 */
export function classifyIgnoredFileCandidate(
  candidate: IgnoredFileCandidate,
): IgnoredFileCandidateKind {
  const name = basename(candidate.path).toLowerCase();

  if (candidate.isDirectory) {
    if (INSTRUCTION_DIRECTORY_NAMES.has(name)) return 'instructions';
    if (DEPENDENCY_DIRECTORY_NAMES.has(name)) return 'dependencies';
    if (BUILD_OUTPUT_DIRECTORY_NAMES.has(name)) return 'buildOutput';
    if (LOG_DIRECTORY_NAMES.has(name)) return 'logs';
    // A directory's contents are unknown, so no extension on its name earns it
    // a kind — the sizes that matter here are the ones a name cannot promise.
    return 'unrecognised';
  }

  if (INSTRUCTION_FILE_NAMES.has(name)) return 'instructions';
  if (CONFIGURATION_FILE_NAMES.has(name)) return 'configuration';
  // `.env`, and every `.env.local`, `.env.development` and friend after it.
  if (name === '.env' || name.startsWith('.env.')) return 'configuration';

  const extension = extensionOf(name);
  if (extension === 'log') return 'logs';
  if (IMAGE_EXTENSIONS.has(extension)) return 'images';
  if (CONFIGURATION_EXTENSIONS.has(extension)) return 'configuration';

  return 'unrecognised';
}

/**
 * Whether a candidate arrives ticked.
 *
 * Configuration and instructions do, because they are what a fresh worktree is
 * missing and are small enough to copy without thinking. Everything else does
 * not — including anything the rules do not recognise, whose size and purpose
 * are both unknown. Leaving the unknown unticked costs a click; ticking it
 * costs whatever the entry turns out to weigh.
 */
export function isIgnoredFileCandidateTickedByDefault(
  candidate: IgnoredFileCandidate,
): boolean {
  const kind = classifyIgnoredFileCandidate(candidate);
  return kind === 'configuration' || kind === 'instructions';
}

/** The last segment of a relative, forward-slashed path. */
function basename(path: string): string {
  const cut = path.lastIndexOf('/');
  return cut === -1 ? path : path.slice(cut + 1);
}

/** The extension of a name, without the dot; empty when there is none. */
function extensionOf(name: string): string {
  const cut = name.lastIndexOf('.');
  // A leading dot names the file rather than starting an extension.
  return cut <= 0 ? '' : name.slice(cut + 1);
}
