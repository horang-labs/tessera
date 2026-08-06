/**
 * The Git action execution module (`docs/design/git-delivery.md` §10).
 *
 * Takes a working directory, an action and that action's parameters, and
 * returns a structured result. It resolves no sessions and reads no database:
 * route handlers look the working directory up themselves so a worktree path
 * never arrives from the client.
 *
 * A failed action comes back as a value, not an exception, and that value keeps
 * everything a delegated recovery would need — the classified failure kind, the
 * exit code, the raw stderr and the change set as it stood afterwards. ADR 0005
 * declines to build that recovery now and requires the detail to survive anyway.
 *
 * A malformed *request* is different from a failed action and throws
 * `GitActionRejection`: nothing ran, and the caller has to fix the request.
 */
import {
  createGitRunner,
  GitCommandError,
  type GitRunner,
} from "@/lib/worktrees/git-runner";
import logger from "@/lib/logger";
import type { AgentEnvironment } from "@/lib/settings/types";
import type {
  GitActionFailure,
  GitActionResult,
  GitChangedFile,
  GitCommitOutcome,
} from "@/types/git";
import { parseGitStatus } from "./git-status";

/**
 * Reads around the action — status before, commit identity after. These are
 * local and answer immediately; the mutating command keeps the runner's own
 * generous default because a pre-commit hook can legitimately run for minutes.
 */
const PROBE_TIMEOUT_MS = 10_000;

/**
 * A change set is read in full here rather than capped the way the panel caps
 * its display list: a path is validated by membership, so a truncated read
 * would reject a file the user can genuinely see.
 */
const CHANGE_SET_MAX_OUTPUT_BYTES = 24 * 1024 * 1024;

/** How much stderr a failure carries to the UI. */
const FAILURE_STDERR_LIMIT = 2000;

export interface GitActionTarget {
  /** In whichever form this server knows it; the runner translates it. */
  workDir: string;
  agentEnvironment: AgentEnvironment;
}

export interface GitCommitAction {
  action: "commit";
  message: string;
  /** Repository-relative paths, each of which must be in the change set. */
  files: string[];
}

/** Widens as `docs/design/git-delivery.md` §2 lands the remaining actions. */
export type GitAction = GitCommitAction;

export type GitActionRejectionCode =
  | "empty_message"
  | "no_files_selected"
  | "file_not_in_change_set";

/**
 * The request was refused before Git ran. Distinct from a `GitActionFailure`,
 * which is Git itself saying no after the command started.
 */
export class GitActionRejection extends Error {
  readonly code: GitActionRejectionCode;

  constructor(code: GitActionRejectionCode, message: string) {
    super(message);
    this.name = "GitActionRejection";
    this.code = code;
  }
}

export async function executeGitAction(
  target: GitActionTarget,
  action: GitAction,
): Promise<GitActionResult> {
  const runGit = createGitRunner(target.agentEnvironment);
  return runCommit(target, action, runGit);
}

async function runCommit(
  target: GitActionTarget,
  action: GitCommitAction,
  runGit: GitRunner,
): Promise<GitActionResult> {
  const message = action.message.trim();
  if (!message) {
    // The button is disabled while the field is empty; this is the second
    // guard `docs/design/git-delivery.md` §5 asks for, on the handler side.
    throw new GitActionRejection("empty_message", "A commit message is required");
  }
  if (action.files.length === 0) {
    throw new GitActionRejection(
      "no_files_selected",
      "Select at least one file to commit",
    );
  }

  const changedFiles = await readChangeSet(target, runGit);
  const { pathspec, untracked } = buildCommitPathspec(action.files, changedFiles);
  let added: string[] = [];

  try {
    // `git commit` only knows paths Git has heard of, so an untracked file has
    // to reach the index first. Nothing else does: a partial commit already
    // records modifications, deletions and renames straight from the tree.
    if (untracked.length > 0) {
      await runGit(["add", "--", ...untracked], { cwd: target.workDir });
      added = untracked;
    }
    // `--only` commits the working-tree contents of exactly these paths and
    // disregards anything else that happens to be staged — which is what lets
    // Tessera leave the index alone. There is no staging UI (§5) and the index
    // is never read back.
    await runGit(["commit", "--only", "--message", message, "--", ...pathspec], {
      cwd: target.workDir,
    });
  } catch (error) {
    await unstageAddedPaths(added, target, runGit);
    return { ok: false, failure: await describeFailure(error, target, runGit) };
  }

  return { ok: true, outcome: await describeCommit(action, pathspec, target, runGit) };
}

interface CommitPathspec {
  /** Everything the commit names, in the order the caller selected it. */
  pathspec: string[];
  /** The subset Git does not track yet. */
  untracked: string[];
}

/**
 * Membership in the change set, not a containment check — the same test the
 * single-file diff route already applies, now per element of the array.
 */
function buildCommitPathspec(
  requested: string[],
  changedFiles: GitChangedFile[],
): CommitPathspec {
  const byPath = new Map(changedFiles.map((file) => [file.path, file]));
  const pathspec: string[] = [];
  const untracked: string[] = [];
  const seen = new Set<string>();

  const include = (candidate: string): void => {
    if (seen.has(candidate)) return;
    seen.add(candidate);
    pathspec.push(candidate);
  };

  for (const requestedPath of requested) {
    const entry = byPath.get(requestedPath);
    if (!entry) {
      throw new GitActionRejection(
        "file_not_in_change_set",
        `File is not part of the current git change set: ${requestedPath}`,
      );
    }

    include(entry.path);
    if (entry.state === "untracked") untracked.push(entry.path);
    // A rename shows up under its new path only; without the old one the commit
    // records the addition and leaves the deletion behind in the tree. A copy
    // names its source the same way, but there the source is a file in its own
    // right and may carry edits the user did not select.
    if (entry.state === "renamed" && entry.previousPath) include(entry.previousPath);
  }

  return { pathspec, untracked };
}

/**
 * Puts back exactly what the `git add` above took. Those paths were untracked,
 * so they were not in the index before and dropping them from it — without
 * touching the working tree — restores the state the user was looking at.
 *
 * §5 keeps staging out of sight, which makes leftover index state the worst
 * kind of residue: no Tessera screen shows it and none can undo it, yet it
 * changes what a later `git commit` outside the panel would sweep in.
 */
async function unstageAddedPaths(
  paths: string[],
  target: GitActionTarget,
  runGit: GitRunner,
): Promise<void> {
  if (paths.length === 0) return;

  try {
    await runGit(["rm", "--cached", "--force", "--quiet", "--", ...paths], {
      cwd: target.workDir,
      timeoutMs: PROBE_TIMEOUT_MS,
    });
  } catch (error) {
    // The commit failure is what the caller has to hear about; this one only
    // means the index kept a path it would otherwise have given up.
    logger.warn(
      { error, workDir: target.workDir, paths },
      "Failed to unstage paths after a failed commit",
    );
  }
}

export async function readChangeSet(
  target: GitActionTarget,
  runGit: GitRunner,
): Promise<GitChangedFile[]> {
  const { stdout } = await runGit(
    ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    {
      cwd: target.workDir,
      timeoutMs: PROBE_TIMEOUT_MS,
      maxOutputBytes: CHANGE_SET_MAX_OUTPUT_BYTES,
    },
  );
  return parseGitStatus(stdout);
}

async function describeFailure(
  error: unknown,
  target: GitActionTarget,
  runGit: GitRunner,
): Promise<GitActionFailure> {
  const changedFiles = await readChangeSet(target, runGit).catch(() => []);

  if (error instanceof GitCommandError) {
    return {
      kind: error.kind,
      message: truncateStderr(error.message),
      stderr: truncateStderr(error.stderr),
      exitCode: error.exitCode,
      changedFiles,
    };
  }

  return {
    kind: "command_failed",
    message: error instanceof Error ? error.message : String(error),
    stderr: "",
    exitCode: null,
    changedFiles,
  };
}

/**
 * Reads back what the commit produced. Both probes swallow their failure: the
 * commit has already landed by this point, and reporting it as failed because a
 * follow-up read stumbled would be the one lie the panel must never tell.
 */
async function describeCommit(
  action: GitCommitAction,
  pathspec: string[],
  target: GitActionTarget,
  runGit: GitRunner,
): Promise<GitCommitOutcome> {
  const probe = { cwd: target.workDir, timeoutMs: PROBE_TIMEOUT_MS };
  const [head, branch] = await Promise.all([
    runGit(["log", "-1", "--format=%H%x09%s"], probe).catch(() => null),
    // Detached HEAD prints nothing, and the caller falls back to the worktree.
    runGit(["branch", "--show-current"], probe).catch(() => null),
  ]);

  const [sha = "", subject = ""] = (head?.stdout ?? "").split("\t");
  return {
    action: "commit",
    sha,
    subject: subject || action.message.trim(),
    branch: branch?.stdout.trim() || null,
    files: pathspec,
  };
}

function truncateStderr(value: string): string {
  if (value.length <= FAILURE_STDERR_LIMIT) return value;
  return `${value.slice(0, FAILURE_STDERR_LIMIT)}…`;
}
