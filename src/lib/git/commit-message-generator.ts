/**
 * Writes a commit message from the files the user selected
 * (`docs/design/git-delivery.md` §6).
 *
 * The generation call itself is a parameter rather than a provider lookup: this
 * module owns *what the model is shown* — the selection and its diff, never the
 * whole change set — and the caller owns which one-shot path runs it.
 */
import { createGitRunner, type GitRunner } from "@/lib/worktrees/git-runner";
import type { GitChangedFile } from "@/types/git";
import {
  GitActionRejection,
  readChangeSet,
  type GitActionTarget,
} from "./git-actions";

/** Reads around the generation, matching the execution module's probe budget. */
const PROBE_TIMEOUT_MS = 10_000;

/**
 * How much diff the prompt carries. The whole prompt is passed to the CLI as a
 * single argument, so an uncapped `git diff` over a regenerated lockfile would
 * both blow the argument limit and spend the model's attention on noise. The
 * head of a diff is where the meaningful hunks are; the rest is told to the
 * model as a truncation notice rather than dropped silently.
 */
const PROMPT_DIFF_LIMIT = 32_000;

/**
 * Runs one headless model call and answers with its raw reply, or null when it
 * produced nothing. ADR 0005 requires this to be the same one-shot path session
 * titles use, so a busy session agent cannot delay a commit.
 */
export type OneShotCommitMessageGenerator = (
  prompt: string,
) => Promise<string | null>;

/**
 * The model call did not produce a message. Separate from `GitActionRejection`
 * — the request was fine — and separate from a Git failure, because nothing in
 * the repository was touched. It fails open by design: the panel reports it on
 * the generate button and leaves committing available.
 */
export class CommitMessageGenerationError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "CommitMessageGenerationError";
  }
}

export async function generateCommitMessage(
  target: GitActionTarget,
  files: string[],
  generate: OneShotCommitMessageGenerator,
): Promise<string> {
  if (files.length === 0) {
    // The button is disabled with nothing selected; this is the guard behind it.
    throw new GitActionRejection(
      "no_files_selected",
      "Select at least one file to summarize",
    );
  }

  const runGit = createGitRunner(target.agentEnvironment);
  const selection = resolveSelection(files, await readChangeSet(target, runGit));
  const diff = await readSelectionDiff(selection, target, runGit);
  let reply: string | null;
  try {
    reply = await generate(buildCommitMessagePrompt(selection, diff));
  } catch (error) {
    throw new CommitMessageGenerationError(
      error instanceof Error ? error.message : String(error),
      { cause: error },
    );
  }

  const message = unwrapModelReply(reply ?? "");
  if (!message) {
    throw new CommitMessageGenerationError(
      "The model returned no commit message",
    );
  }
  return message;
}

/**
 * Strips the presentation a model wraps an answer in. It goes straight into an
 * editable field the user then commits, so a stray fence or pair of quotes would
 * end up in the repository's history.
 */
function unwrapModelReply(reply: string): string {
  let text = reply.trim();

  const fenced = text.match(/^```[^\n]*\n([\s\S]*?)\n?```$/);
  if (fenced) text = fenced[1].trim();

  if (text.length > 1 && text.startsWith('"') && text.endsWith('"')) {
    text = text.slice(1, -1).trim();
  }

  return text;
}

/**
 * Membership in the change set, the same test the commit action applies — a
 * summary of a path the user cannot see selected would be a summary of nothing.
 */
function resolveSelection(
  requested: string[],
  changedFiles: GitChangedFile[],
): GitChangedFile[] {
  const byPath = new Map(changedFiles.map((file) => [file.path, file]));

  return requested.map((requestedPath) => {
    const entry = byPath.get(requestedPath);
    if (!entry) {
      throw new GitActionRejection(
        "file_not_in_change_set",
        `File is not part of the current git change set: ${requestedPath}`,
      );
    }
    return entry;
  });
}

async function readSelectionDiff(
  selection: GitChangedFile[],
  target: GitActionTarget,
  runGit: GitRunner,
): Promise<string> {
  const pathspec = selection.flatMap((file) =>
    file.previousPath ? [file.path, file.previousPath] : [file.path],
  );

  const { stdout } = await runGit(
    ["diff", "--no-ext-diff", "--no-color", "--unified=3", "HEAD", "--", ...pathspec],
    {
      cwd: target.workDir,
      timeoutMs: PROBE_TIMEOUT_MS,
      // Capped at the source as well as at the prompt: buffering hundreds of
      // megabytes only to slice 32KB off the front is work nobody asked for.
      maxOutputBytes: PROMPT_DIFF_LIMIT * 2,
    },
  );
  return stdout;
}

function buildCommitMessagePrompt(
  selection: GitChangedFile[],
  diff: string,
): string {
  const fileList = selection
    .map((file) => `  - ${file.path} (${file.state})`)
    .join("\n");
  const truncated = diff.length > PROMPT_DIFF_LIMIT;
  const body = truncated ? diff.slice(0, PROMPT_DIFF_LIMIT) : diff;

  return `Write a git commit message for the staged selection below.

SELECTED FILES:
${fileList}

DIFF:
${body}${truncated ? "\n… diff truncated; summarize from the files listed above" : ""}
END OF DIFF.

Output a single JSON object with:
- "title": the commit subject line, imperative mood, at most 72 characters

IMPORTANT: Output ONLY the JSON object. No explanation, no markdown.
{"title":"fix: reject empty commit messages"}`;
}
