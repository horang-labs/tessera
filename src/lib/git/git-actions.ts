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
  hasGitDiagnosticLine,
  type GitFailureKind,
  type GitRunner,
} from "@/lib/worktrees/git-runner";
import {
  createGhRunner,
  type GhCommandResult,
  type GhRunner,
} from "@/lib/github/gh-cli";
import { normalizeGithubOwnerRepo } from "@/lib/github/pr-status-provider";
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

/**
 * Publishing a branch is this same action; only the label differs (§2). What
 * the push does about an upstream is read from the repository, not from the
 * request, so the client cannot ask for a tracking branch it has not seen.
 */
export interface GitPushAction {
  action: "push";
}

/**
 * Catching the worktree up with its upstream. Like push, it takes no parameters:
 * which branch is pulled from where is the repository's answer, not the
 * client's.
 */
export interface GitPullAction {
  action: "pull";
}

/**
 * Opening the pull request. Like push it takes no parameters: the branch, the
 * repository and the base all come from the repository and from GitHub, so the
 * client cannot direct a pull request anywhere it has not been shown.
 */
export interface GitCreatePullRequestAction {
  action: "create_pr";
}

/** Widens as `docs/design/git-delivery.md` §2 lands the remaining actions. */
export type GitAction =
  | GitCommitAction
  | GitPushAction
  | GitPullAction
  | GitCreatePullRequestAction;

export type GitActionRejectionCode =
  | "empty_message"
  | "no_files_selected"
  | "file_not_in_change_set"
  | "detached_head"
  | "no_remote"
  | "no_upstream"
  | "not_github_remote";

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
  if (action.action === "push") return runPush(target, runGit);
  if (action.action === "pull") return runPull(target, runGit);
  if (action.action === "create_pr") {
    // The GitHub CLI runs where the agent does, for the same reason Git does
    // (ADR 0006). It is passed in rather than reached for inside, so the one
    // part of this action that cannot be stood up in a test is the one part a
    // test replaces.
    return runCreatePullRequest(
      target.workDir,
      runGit,
      createGhRunner(target.agentEnvironment),
    );
  }
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
    return {
      ok: false,
      failure: await describeFailure(error, target, runGit, promoteHookRejection),
    };
  }

  return { ok: true, outcome: await describeCommit(action, pathspec, target, runGit) };
}

/**
 * Push, and Publish Branch, which is the same command with the upstream it is
 * missing. Which of the two ran is read back from the repository afterwards and
 * reported, so a first push is explained after the fact as well as before it
 * (`docs/design/git-delivery.md` §7).
 */
async function runPush(
  target: GitActionTarget,
  runGit: GitRunner,
): Promise<GitActionResult> {
  const branch = await readCurrentBranch(target.workDir, runGit);
  if (!branch) {
    // The button is disabled on a detached HEAD; this is the handler-side guard.
    throw new GitActionRejection(
      "detached_head",
      "HEAD is detached, so there is no branch to push",
    );
  }

  const upstream = await readUpstream(target.workDir, runGit);
  const args = upstream
    ? ["push"]
    : ["push", "--set-upstream", await resolvePushRemote(target, runGit), branch];

  try {
    // No `timeoutMs`: the runner's own generous default stands, because a
    // pre-push hook — or a large first push — legitimately runs for minutes.
    await runGit(args, { cwd: target.workDir });
  } catch (error) {
    // No commit-specific promotion here. `git push` failing in silence is a
    // network or a permission problem far more often than a hook, and the
    // runner already recognizes a `pre-push` hook that says anything at all.
    return {
      ok: false,
      failure: await describeFailure(error, target, runGit, (failed) => failed.kind),
    };
  }

  return {
    ok: true,
    outcome: {
      action: "push",
      branch,
      // Read back rather than assembled: after `--set-upstream` this is Git's
      // own answer about which remote branch now exists.
      remoteBranch: (await readUpstream(target.workDir, runGit)) ?? upstream,
      setUpstream: !upstream,
    },
  };
}

/**
 * The last step of delivery (`docs/design/git-delivery.md` §2, §3). The branch,
 * the repository and the base are all read from the repository or from GitHub —
 * nothing about the pull request is chosen here, and nothing is taken from the
 * client, so there is no ref for a caller to point somewhere else.
 *
 * Exported so a test can drive it with a fake `gh`; `executeGitAction` is the
 * only production caller.
 */
export async function runCreatePullRequest(
  workDir: string,
  runGit: GitRunner,
  runGh: GhRunner,
): Promise<GitActionResult> {
  const branch = await readCurrentBranch(workDir, runGit);
  if (!branch) {
    throw new GitActionRejection(
      "detached_head",
      "HEAD is detached, so there is no branch to open a pull request from",
    );
  }

  const upstream = await readUpstream(workDir, runGit);
  if (!upstream) {
    // The ladder only offers this rung to a branch that tracks; a click that
    // raced the state lands here rather than in gh's own prompt.
    throw new GitActionRejection(
      "no_upstream",
      "Publish the branch before opening a pull request",
    );
  }

  const repository = await readGitHubRepository(workDir, upstream, runGit);

  // `--fill` takes the title and body from the commits, which is the only
  // source there is: §3 gives this action one button and no form. No `--base`:
  // GitHub's own default for the repository is the base asked for, and what it
  // chose is read back below rather than assumed here.
  const created = await runGh(
    ["pr", "create", "--repo", repository, "--head", branch, "--fill"],
    { cwd: workDir },
  );
  if (created.exitCode !== 0) {
    return { ok: false, failure: describeGhFailure(created) };
  }

  const opened = await readOpenedPullRequest(workDir, repository, branch, runGh);
  return {
    ok: true,
    outcome: {
      action: "create_pr",
      branch,
      // The read-back first, then what `gh pr create` printed. Both can be
      // missing without the pull request being missing — it exists the moment
      // gh exits zero, and a report that stumbled afterwards must not turn that
      // into a failure.
      url: opened?.url ?? readPullRequestUrl(created.stdout),
      number: opened?.number ?? null,
      baseBranch: opened?.baseRefName ?? null,
    },
  };
}

/**
 * Which GitHub repository this branch pushes to. Read from the remote the
 * branch actually tracks rather than from `origin` by name, because the two are
 * only the same by convention.
 */
async function readGitHubRepository(
  workDir: string,
  upstream: string,
  runGit: GitRunner,
): Promise<string> {
  const remote = upstream.split("/", 1)[0]?.trim() || "origin";
  const result = await runGit(["remote", "get-url", remote], {
    cwd: workDir,
    timeoutMs: PROBE_TIMEOUT_MS,
  }).catch(() => null);

  const repository = normalizeGithubOwnerRepo(result?.stdout.trim() ?? null);
  if (!repository) {
    // §4's rule for an action that cannot run: say why, and say it in terms of
    // what the repository is missing rather than what gh would have printed.
    throw new GitActionRejection(
      "not_github_remote",
      `The remote "${remote}" is not a GitHub repository, so there is no pull request to open`,
    );
  }

  return repository;
}

interface OpenedPullRequest {
  number: number | null;
  url: string | null;
  baseRefName: string | null;
}

/**
 * What GitHub made of the request. Null when the read stumbled: the pull request
 * is already open at that point, so the caller reports what it still knows
 * rather than reporting a failure that did not happen.
 */
async function readOpenedPullRequest(
  workDir: string,
  repository: string,
  branch: string,
  runGh: GhRunner,
): Promise<OpenedPullRequest | null> {
  const viewed = await runGh(
    ["pr", "view", branch, "--repo", repository, "--json", "number,url,baseRefName"],
    { cwd: workDir },
  ).catch(() => null);
  if (!viewed || viewed.exitCode !== 0) return null;

  try {
    const payload = JSON.parse(viewed.stdout) as Record<string, unknown>;
    return {
      number: typeof payload.number === "number" ? payload.number : null,
      url: typeof payload.url === "string" ? payload.url : null,
      baseRefName:
        typeof payload.baseRefName === "string" ? payload.baseRefName : null,
    };
  } catch {
    return null;
  }
}

/** What `gh pr create` prints when it succeeds: the URL, on a line of its own. */
function readPullRequestUrl(stdout: string): string | null {
  const match = stdout.match(/https?:\/\/\S+\/pull\/\d+/);
  return match?.[0] ?? null;
}

/**
 * gh is not Git, so `GitCommandError`'s classification does not reach it. The
 * two kinds worth promoting out of a generic failure are the ones the user can
 * act on: gh is not installed here, and gh is not signed in.
 */
function describeGhFailure(result: GhCommandResult): GitActionFailure {
  const stderr = result.stderr.trim();

  return {
    kind: classifyGhFailure(result),
    message: truncateStderr(stderr || "The GitHub CLI (gh) failed"),
    stderr: truncateStderr(result.stderr),
    // gh splits its account the way `git pull` does: `gh pr create` prints the
    // URL it made on stdout and its complaint on stderr, so a failure that kept
    // only one of the two could drop the half that says what happened.
    stdout: truncateStderr(result.stdout),
    exitCode: result.exitCode,
    // Empty rather than read: opening a pull request runs no command that can
    // touch the working tree, so there is no change set this failure moved. The
    // detail ADR 0005 asks to keep is the kind and the stderr, and both are here.
    changedFiles: [],
  };
}

function classifyGhFailure(result: GhCommandResult): GitFailureKind {
  // Killed by the runner rather than answered by GitHub — the network, not the
  // request, and pressing the button again is the right response.
  if (result.timedOut) return "timeout";
  // A null exit code is otherwise a process that never started. In practice that
  // is gh missing from the agent environment, which is a different thing to fix
  // from anything gh could have told us.
  if (result.exitCode === null) return "spawn_failed";
  if (/gh auth login|authentication token|not logged in/i.test(result.stderr)) {
    return "authentication";
  }
  return "command_failed";
}

/**
 * Pull, which is how the panel catches a worktree up without a terminal
 * (`docs/design/git-delivery.md` §3). Bare `git pull` rather than a pinned
 * strategy: the repository's own `pull.rebase` / `pull.ff` configuration is the
 * user's answer to how their branches reconcile, and Tessera has no screen on
 * which to ask the question again.
 */
async function runPull(
  target: GitActionTarget,
  runGit: GitRunner,
): Promise<GitActionResult> {
  const branch = await readCurrentBranch(target.workDir, runGit);
  if (!branch) {
    throw new GitActionRejection(
      "detached_head",
      "HEAD is detached, so there is no branch to pull into",
    );
  }

  const upstream = await readUpstream(target.workDir, runGit);
  if (!upstream) {
    // The ladder only offers Pull on a branch that is behind something, which
    // takes an upstream; this is the handler-side guard for a click that raced
    // the state it was derived from.
    throw new GitActionRejection(
      "no_upstream",
      "This branch has no upstream to pull from",
    );
  }

  try {
    // No `timeoutMs`: the runner's generous default stands, because the fetch
    // half of a pull is as slow as the network and a merge can run hooks.
    await pullWithDivergenceFallback(target, runGit);
  } catch (error) {
    // No commit-specific promotion: a pull's merge hooks name themselves, and
    // the runner already recognizes those.
    return {
      ok: false,
      failure: await describeFailure(error, target, runGit, (failed) => failed.kind),
    };
  }

  return { ok: true, outcome: { action: "pull", branch, upstream } };
}

/**
 * Git 2.27 and later refuse a divergent pull outright when the repository pins
 * no reconciliation policy, and say only that one must be chosen. That refusal
 * is not a state the user can leave from this panel — there is no setting to
 * change and pressing the same button again fails identically — so it is
 * answered here with `--no-rebase`, the merge Git itself did before it started
 * asking. A repository that *has* configured a policy never reaches this: the
 * first attempt already obeyed it.
 */
async function pullWithDivergenceFallback(
  target: GitActionTarget,
  runGit: GitRunner,
): Promise<void> {
  try {
    await runGit(["pull"], { cwd: target.workDir });
  } catch (error) {
    if (!isDivergentPullRefusal(error)) throw error;
    await runGit(["pull", "--no-rebase"], { cwd: target.workDir });
  }
}

/**
 * English, like every pattern in the runner, and Git translates this text — a
 * localized Git therefore falls through and reports its own refusal, which is
 * the same assumption `classifyGitFailure` has always made.
 */
const DIVERGENT_PULL_PATTERNS = [
  "need to specify how to reconcile divergent branches",
  "divergent branches and need to specify how to reconcile them",
];

function isDivergentPullRefusal(error: unknown): boolean {
  if (!(error instanceof GitCommandError)) return false;
  const haystack = `${error.stderr}\n${error.message}`.toLowerCase();
  return DIVERGENT_PULL_PATTERNS.some((pattern) => haystack.includes(pattern));
}

/**
 * Which remote a branch that has never been published goes to. `origin` is the
 * name Git itself defaults to and the only one the panel reads elsewhere; a
 * repository that named its single remote something else still gets a push
 * rather than a "no such remote".
 */
async function resolvePushRemote(
  target: GitActionTarget,
  runGit: GitRunner,
): Promise<string> {
  const { stdout } = await runGit(["remote"], {
    cwd: target.workDir,
    timeoutMs: PROBE_TIMEOUT_MS,
  });
  const remotes = stdout.split("\n").map((line) => line.trim()).filter(Boolean);

  if (remotes.length === 0) {
    throw new GitActionRejection(
      "no_remote",
      "This repository has no remote to push to",
    );
  }

  return remotes.includes("origin") ? "origin" : remotes[0]!;
}

/** Empty on a detached HEAD, which is the caller's cue that there is no branch. */
async function readCurrentBranch(
  workDir: string,
  runGit: GitRunner,
): Promise<string | null> {
  const { stdout } = await runGit(["branch", "--show-current"], {
    cwd: workDir,
    timeoutMs: PROBE_TIMEOUT_MS,
  });
  return stdout.trim() || null;
}

/** Null both when there is no upstream and when Git could not be asked. */
async function readUpstream(
  workDir: string,
  runGit: GitRunner,
): Promise<string | null> {
  const result = await runGit(
    ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
    { cwd: workDir, timeoutMs: PROBE_TIMEOUT_MS },
  ).catch(() => null);

  return result?.stdout.trim() || null;
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

/**
 * `classify` is where the caller adds what it knows and the runner cannot: the
 * commit path can read silence as a hook refusing, a push cannot.
 *
 * Both output streams are kept. Which of them carries the reason is the
 * command's business, not this function's — `git commit` explains itself on
 * stderr, `git pull` reports its merge on stdout — and ADR 0005 asks for the
 * detail to survive rather than for a choice to be made here.
 */
async function describeFailure(
  error: unknown,
  target: GitActionTarget,
  runGit: GitRunner,
  classify: (error: GitCommandError) => GitFailureKind,
): Promise<GitActionFailure> {
  const changedFiles = await readChangeSet(target, runGit).catch(() => []);

  if (error instanceof GitCommandError) {
    return {
      kind: classify(error),
      message: truncateStderr(error.message),
      stderr: truncateStderr(error.stderr),
      stdout: truncateStderr(error.stdout),
      exitCode: error.exitCode,
      changedFiles,
    };
  }

  return {
    kind: "command_failed",
    message: error instanceof Error ? error.message : String(error),
    stderr: "",
    stdout: "",
    exitCode: null,
    changedFiles,
  };
}

/**
 * What `git commit` exits with when a hook refuses. Anything else came from
 * somewhere other than Git declining the commit, which matters because a
 * bridged agent environment wraps the command in
 * `sh -c "cd -- '<path>' && exec git …"` (`spawn-cli-runtime.ts`): a wrapper
 * that fails reports sh's stderr and sh's exit code — 2 for an unreachable
 * working directory, 127 for a missing binary — and `null` means the process
 * was killed from outside and never reported at all. `exec` passes Git's own
 * code through untouched, so a real hook rejection still arrives as 1.
 */
const GIT_COMMIT_REJECTED_EXIT_CODE = 1;

/**
 * The runner classifies by what the output says, which catches a hook that
 * names itself or its runner. Here the command is known to be `git commit`, and
 * that supports the stronger inference the runner cannot make on its own: when
 * Git refuses a commit for its own reasons it always explains itself, in its
 * own voice, on stderr. So a commit that failed while Git said nothing was
 * refused by something Git invoked — a hook — whether that hook printed a
 * complaint of its own or exited in silence.
 *
 * `stdout` guards the one case where Git reports without a diagnostic prefix:
 * "nothing added to commit" goes there, and it is Git speaking, not a hook.
 *
 * Exported for the tests that pin the exit codes this must not promote; nothing
 * else calls it.
 */
export function promoteHookRejection(error: GitCommandError): GitFailureKind {
  if (error.kind !== 'command_failed') return error.kind;
  if (error.exitCode !== GIT_COMMIT_REJECTED_EXIT_CODE) return error.kind;
  if (error.stdout.trim()) return error.kind;
  if (hasGitDiagnosticLine(error.stderr)) return error.kind;

  return 'hook_rejected';
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
