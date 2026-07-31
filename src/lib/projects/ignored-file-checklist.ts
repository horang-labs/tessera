/**
 * What the checklist shows, and what arrives ticked.
 *
 * The scan says what the checkout ignores and the copy block says what was
 * confirmed last time; between them there is nothing left to remember, which
 * is why no tick state is stored anywhere. Pure, so the rules are testable
 * without a browser: the component only renders what this returns.
 */

import {
  classifyIgnoredFileCandidate,
  isIgnoredFileCandidateTickedByDefault,
  type IgnoredFileCandidate,
  type IgnoredFileCandidateKind,
} from './ignored-file-candidates';
import { hasCopyBlock, readCopiedCandidates } from './preparation-copy-block';

export interface ChecklistEntry extends IgnoredFileCandidate {
  kind: IgnoredFileCandidateKind;
  /**
   * The block copies it, but the scan no longer finds it. Shown so that
   * unticking stays the only way a command leaves the block, even for a file
   * the checkout has since lost.
   */
  inScriptOnly: boolean;
}

export interface IgnoredFileChecklist {
  entries: ChecklistEntry[];
  /** The paths that arrive ticked, in no particular order. */
  tickedPaths: string[];
}

/**
 * What a worktree is missing comes first and what it is better off without
 * comes last, so accepting the defaults means reading the top of the list. A
 * file the checkout has lost leads, because it is the one entry nobody can
 * find out about any other way.
 */
const KIND_ORDER: Record<IgnoredFileCandidateKind, number> = {
  configuration: 0,
  instructions: 1,
  unrecognised: 2,
  logs: 3,
  images: 4,
  buildOutput: 5,
  dependencies: 6,
};

/**
 * Build the checklist for a scan against the script as it currently stands.
 *
 * A block that exists is the last thing confirmed, so it decides the ticks on
 * its own — including the candidates deliberately left out of it. Falling back
 * to the defaults there would put back, on every reopen, exactly what the user
 * unticked. Only a script that has never had a block takes the defaults.
 */
export function buildIgnoredFileChecklist(
  scanned: IgnoredFileCandidate[],
  script: string,
): IgnoredFileChecklist {
  const copied = readCopiedCandidates(script);
  const scannedPaths = new Set(scanned.map((candidate) => candidate.path));

  const entries = [
    ...copied
      .filter((candidate) => !scannedPaths.has(candidate.path))
      .map((candidate) => toEntry(candidate, true)),
    ...scanned.map((candidate) => toEntry(candidate, false)),
  ].sort(byReadingOrder);

  const ticked = hasCopyBlock(script)
    ? copied
    : scanned.filter(isIgnoredFileCandidateTickedByDefault);

  return { entries, tickedPaths: ticked.map((candidate) => candidate.path) };
}

function toEntry(candidate: IgnoredFileCandidate, inScriptOnly: boolean): ChecklistEntry {
  return {
    ...candidate,
    kind: classifyIgnoredFileCandidate(candidate),
    inScriptOnly,
  };
}

function byReadingOrder(left: ChecklistEntry, right: ChecklistEntry): number {
  if (left.inScriptOnly !== right.inScriptOnly) return left.inScriptOnly ? -1 : 1;
  const byKind = KIND_ORDER[left.kind] - KIND_ORDER[right.kind];
  return byKind !== 0 ? byKind : left.path.localeCompare(right.path);
}
