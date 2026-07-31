/**
 * The block of copy commands a preparation script keeps on Tessera's behalf.
 *
 * The checklist owns a marked region of the script and nothing else. That
 * ownership is what makes confirming safe to do without asking: the block is
 * rewritten wholesale from the ticks, so unticking removes a command as
 * readily as ticking adds one, and no rule has to guess whether some line the
 * user wrote is "the same" copy under a different spelling. A generated line
 * dragged out of the block stops being Tessera's and survives every later
 * rewrite.
 *
 * Pure throughout: the caller reads the stored script, asks for the rewritten
 * one, and saves it.
 */

import type { IgnoredFileCandidate } from './ignored-file-candidates';
import { PREPARATION_PROJECT_DIR_ENV } from './preparation-environment';

export const COPY_BLOCK_OPEN_MARKER = '# >>> tessera: files copied into each worktree >>>';
export const COPY_BLOCK_CLOSE_MARKER = '# <<< tessera <<<';
/** Says, inside the block itself, how to keep a line the rewrite would drop. */
export const COPY_BLOCK_NOTICE =
  '# Rewritten from the checklist. Move a line out of this block to keep your own version.';

/** The body of a double-quoted word: anything but a quote, or an escape pair. */
const QUOTED_BODY = '(?:[^"\\\\]|\\\\.)';

/**
 * A generated copy command, in the one shape this module writes and reads.
 *
 * Anything else inside the block — a command the user edited into `cp -a`, or
 * into rsync — no longer matches, and is therefore not read back as a tick.
 * The next confirmation drops it, which is what the notice line warns about.
 */
const COPY_COMMAND_PATTERN = new RegExp(
  `^(?:mkdir -p "${QUOTED_BODY}*" && )?`
  + 'cp (?:(-R) )?'
  + `"\\$${PREPARATION_PROJECT_DIR_ENV}/(${QUOTED_BODY}+)" `
  + `(?:\\.|"${QUOTED_BODY}*")$`,
);

/**
 * The command that copies one candidate out of the original checkout.
 *
 * The checkout is named by its exposed value rather than spelled out, so the
 * script means the same thing on every machine the project is cloned to. A
 * nested entry has the directory that will hold it made first, because the
 * worktree is fresh and git only carries the directories it tracks.
 */
export function buildCopyCommand(candidate: IgnoredFileCandidate): string {
  const flag = candidate.isDirectory ? '-R ' : '';
  const source = `"$${PREPARATION_PROJECT_DIR_ENV}/${quoteBody(candidate.path)}"`;
  const parent = parentDirectoryOf(candidate.path);

  return parent
    ? `mkdir -p "${quoteBody(parent)}" && cp ${flag}${source} "${quoteBody(parent)}"`
    : `cp ${flag}${source} .`;
}

/**
 * Whether the script holds a block at all.
 *
 * It is the difference between a checklist nobody has confirmed yet, whose
 * ticks come from the defaults, and one whose ticks are whatever was confirmed
 * last time — including the candidates deliberately left out.
 */
export function hasCopyBlock(script: string): boolean {
  return findBlockBounds(splitLines(script)) !== null;
}

/**
 * The candidates the block currently copies.
 *
 * This is the whole of the stored tick state: nothing is persisted, so
 * reopening the checklist reads the block and ticks whatever it finds.
 */
export function readCopiedCandidates(script: string): IgnoredFileCandidate[] {
  const lines = splitLines(script);
  const bounds = findBlockBounds(lines);
  if (!bounds) return [];

  const candidates: IgnoredFileCandidate[] = [];
  for (let index = bounds.open + 1; index < bounds.close; index += 1) {
    const candidate = readCopyCommand(lines[index]);
    if (candidate) candidates.push(candidate);
  }
  return candidates;
}

/**
 * Rewrite the block to copy exactly these candidates, leaving every other line
 * of the script where it was.
 *
 * With no candidates left the block goes too, markers and all, so a script
 * that copies nothing looks like one that never copied anything. With no block
 * present the new one leads, because copying has to happen before whatever
 * installs or builds from what was copied.
 */
export function rewriteCopyBlock(
  script: string,
  candidates: IgnoredFileCandidate[],
): string {
  const lines = splitLines(script);
  const bounds = findBlockBounds(lines);
  const block = candidates.length > 0
    ? [COPY_BLOCK_OPEN_MARKER, COPY_BLOCK_NOTICE, ...candidates.map(buildCopyCommand), COPY_BLOCK_CLOSE_MARKER]
    : [];

  if (!bounds) {
    if (block.length === 0) return lines.join('\n');
    // A blank line keeps the block from reading as part of what follows it.
    // What follows is untouched, blank leading lines included: the script
    // outside the block is the user's, and tidying it is not this rewrite's
    // business.
    const rest = lines.join('\n');
    return rest.trim() ? `${block.join('\n')}\n\n${rest}` : block.join('\n');
  }

  const before = lines.slice(0, bounds.open);
  let after = lines.slice(bounds.close + 1);
  // Removing the block takes the blank line that separated it, so clearing the
  // checklist does not leave the script starting with an empty line.
  if (block.length === 0 && after[0] === '') after = after.slice(1);

  return [...before, ...block, ...after].join('\n');
}

/** Read one line back as the candidate it copies, or null if it is not ours. */
function readCopyCommand(line: string): IgnoredFileCandidate | null {
  const match = COPY_COMMAND_PATTERN.exec(line.trim());
  if (!match) return null;
  return { path: match[2].replace(/\\([\\$`"])/g, '$1'), isDirectory: match[1] === '-R' };
}

/**
 * Where the block starts and ends, or null when the script has no whole one.
 *
 * A marker without its partner is left to the user as the ordinary text it now
 * is: treating half a block as a block is how a rewrite would eat the lines
 * around it.
 */
function findBlockBounds(lines: string[]): { open: number; close: number } | null {
  const open = lines.findIndex((line) => line.trim() === COPY_BLOCK_OPEN_MARKER);
  if (open === -1) return null;

  const close = lines.findIndex(
    (line, index) => index > open && line.trim() === COPY_BLOCK_CLOSE_MARKER,
  );
  return close === -1 ? null : { open, close };
}

/**
 * Escape a path for the inside of a double-quoted shell word.
 *
 * Double quotes rather than the single quotes `escapeShellPath` uses, because
 * the command has to keep the checkout's exposed name expanding while the path
 * beside it does not: `"$TESSERA_PROJECT_DIR/a$b.json"` would otherwise copy
 * whatever `$b` happens to hold. Only these four characters mean anything
 * inside double quotes, so escaping them is the whole of the job.
 */
function quoteBody(path: string): string {
  return path.replace(/[\\$`"]/g, '\\$&');
}

/** Everything before the last segment, or empty for a top-level entry. */
function parentDirectoryOf(path: string): string {
  const cut = path.lastIndexOf('/');
  return cut === -1 ? '' : path.slice(0, cut);
}

/**
 * A script may arrive with the line endings of wherever it was typed, and
 * leaves with newlines.
 *
 * Rejoining a CRLF script with newlines changes lines outside the block too,
 * but only in the way storing it already does: `normalizePreparationScript` is
 * what every save goes through, and it settles on newlines for exactly the
 * reason this does — a script written on Windows has to read back the same
 * everywhere.
 */
function splitLines(script: string): string[] {
  return script.replace(/\r\n?/g, '\n').split('\n');
}
