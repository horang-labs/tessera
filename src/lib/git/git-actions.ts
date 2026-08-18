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
  GitConflictOperation,
} from "@/types/git";
import { detectGitConflictOperation } from "./git-conflict-state";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { parseGitStatus } from "./git-status";
import { canRevertFile } from "./revert-eligibility";
import {
  resolveConfiguredUpstream,
  type ConfiguredUpstream,
} from "./upstream-config";

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

/**
 * The way out of an unfinished merge, rebase or cherry-pick (§9). Like the rest
 * it takes no parameters: *which* operation is aborted is read from the worktree
 * here, not asked for, so a menu drawn a moment ago cannot ask for a
 * `git rebase --abort` on a worktree that is now mid-merge.
 */
export interface GitAbortAction {
  action: "abort";
}

/**
 * Reverting selected changed files: their working trees are restored to HEAD,
 * or the file is deleted outright when it has no HEAD version (untracked).
 * `files` must each be in the change set (`docs/design/git-delivery.md` §2).
 */
export interface GitRevertAction {
  action: "revert";
  files: string[];
}

/** Widens as `docs/design/git-delivery.md` §2 lands the remaining actions. */
export type GitAction =
  | GitCommitAction
  | GitPushAction
  | GitPullAction
  | GitCreatePullRequestAction
  | GitAbortAction
  | GitRevertAction;

export type GitActionRejectionCode =
  | "empty_message"
  | "no_files_selected"
  | "file_not_in_change_set"
  | "detached_head"
  | "no_remote"
  | "no_upstream"
  | "not_github_remote"
  | "no_conflict_in_progress"
  | "not_revertible";

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
  if (action.action === "abort") return runAbort(target, runGit);
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
  if (action.action === "revert") return runRevert(target, action, runGit);
  return runCommit(target, action, runGit);
}

async function runRevert(
  target: GitActionTarget,
  action: GitRevertAction,
  runGit: GitRunner,
): Promise<GitActionResult> {
  if (action.files.length === 0) {
    throw new GitActionRejection(
      "no_files_selected",
      "Select at least one file to revert",
    );
  }

  const changedFiles = await readChangeSet(target, runGit);
  const byPath = new Map(changedFiles.map((file) => [file.path, file]));
  for (const filePath of action.files) {
    const file = byPath.get(filePath);
    // The button is built from the same change set this reads, so a mismatch
    // means the list changed underneath the click — reject rather than guess.
    if (!file) {
      throw new GitActionRejection(
        "file_not_in_change_set",
        `Not a changed file: ${filePath}`,
      );
    }
    if (!canRevertFile(file)) {
      throw new GitActionRejection(
        "not_revertible",
        `Cannot revert ${filePath}: it is conflicted or only staged`,
      );
    }
  }

  // Each file runs its own command so one failure does not abort the rest, and
  // the outcome keeps the paths in selection order.
  try {
    for (const filePath of action.files) {
      const file = byPath.get(filePath)!;
      if (file.state === "untracked") {
        // No HEAD version to restore to; orca discards these by deleting.
        // `git rm` cannot remove an untracked path, so delete it directly.
        await rm(join(target.workDir, filePath));
      } else {
        await runGit(["restore", "--source=HEAD", "--worktree", "--", filePath], {
          cwd: target.workDir,
        });
      }
    }
  } catch (error) {
    // A partial revert still leaves the tree in a real state; the failure
    // carries the change set as it stood after, so the panel shows the truth.
    return {
      ok: false,
      failure: await describeFailure(error, target, runGit, (failed) => failed.kind),
    };
  }

  return { ok: true, outcome: { action: "revert", files: action.files } };
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
 *
 * Exported for the same reason `runCreatePullRequest` is: the state it has to
 * refuse — a push that succeeds and leaves the branch tracking nothing — is one
 * no real repository can be asked to produce on demand, so a test supplies the
 * runner instead. `executeGitAction` is the only production caller.
 */
export async function runPush(
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

  const upstream = await readUpstream(target.workDir, runGit, branch);
  // Kept in a variable rather than inlined: the failure below names the remote
  // the push went to, and by then the arguments have been forgotten.
  const remote = upstream ? null : await resolvePushRemote(target, runGit);
  const args = remote
    ? ["push", "--set-upstream", remote, branch]
    : ["push"];

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

  // Read back rather than assembled: after `--set-upstream` this is Git's own
  // answer about which remote branch now exists.
  const remoteBranch = (await readUpstream(target.workDir, runGit, branch)) ?? upstream;
  if (!remoteBranch) {
    // We pushed *with* `--set-upstream` and still cannot see an upstream. That
    // is a contradiction, not a success: the two facts cannot both hold unless
    // something outside the push is swallowing the tracking link.
    return {
      ok: false,
      failure: await describeMissingTrackingRef(target, branch, remote, runGit),
    };
  }

  return {
    ok: true,
    outcome: {
      action: "push",
      branch,
      remoteBranch,
      setUpstream: !upstream,
    },
  };
}

/**
 * The push landed and the branch still tracks nothing.
 *
 * In practice this is one repository shape: a clone whose `remote.origin.fetch`
 * covers only some branches. `--set-upstream` writes the config, but Git
 * resolves an upstream through the refspec, so the link it just wrote is one it
 * will not read back — and `git push` exits 0 saying "Everything up-to-date"
 * because the commit really is on the remote. Left as a success this is the
 * worst failure the panel can have: the button reports done, nothing changes,
 * and the next refresh offers the same button again.
 *
 * The message carries the fetch that repairs it. Tessera does not run it: a
 * refspec is the user's decision about what their clone holds, and widening it
 * behind their back would fetch refs they narrowed it to avoid.
 */
async function describeMissingTrackingRef(
  target: GitActionTarget,
  branch: string,
  remote: string | null,
  runGit: GitRunner,
): Promise<GitActionFailure> {
  const remoteName = remote ?? "origin";
  const repoRoot = await readRepoRoot(target.workDir, runGit);
  const message = [
    `Pushed ${branch} to ${remoteName}, but this repository still has no remote-tracking`,
    ` ref for it: its fetch refspec does not cover ${branch}, so Git cannot tell whether the`,
    ` branch is published or how far ahead it is. Create the ref with:\n`,
    `  git -C ${repoRoot} fetch ${remoteName} ${branch}:refs/remotes/${remoteName}/${branch}`,
  ].join("");

  return {
    kind: "no_tracking_ref",
    message,
    // Nothing failed on either stream — the push itself succeeded, and saying so
    // with an empty stderr is more honest than inventing one.
    stderr: "",
    stdout: "",
    exitCode: 0,
    changedFiles: await readChangeSet(target, runGit).catch(() => []),
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

  const upstream = await readUpstream(workDir, runGit, branch);
  if (!upstream) {
    // The ladder only offers this rung to a branch that tracks; a click that
    // raced the state lands here rather than in gh's own prompt.
    throw new GitActionRejection(
      "no_upstream",
      "Publish the branch before opening a pull request",
    );
  }

  const repository = await readGitHubRepository(workDir, upstream, runGit);

  // The panel is advisory state. Re-check at the mutation boundary so another
  // tab, process, or GitHub action cannot turn a stale enabled button into a
  // duplicate-create error.
  const existing = await readExistingOpenPullRequest(
    workDir,
    repository,
    branch,
    runGh,
  );
  if (existing.kind === "failure") {
    return { ok: false, failure: existing.failure };
  }
  if (existing.kind === "found") {
    return {
      ok: true,
      outcome: {
        action: "create_pr",
        disposition: "existing",
        branch,
        url: existing.pullRequest.url,
        number: existing.pullRequest.number,
        baseBranch: existing.pullRequest.baseRefName,
      },
    };
  }

  // `--fill` takes the title and body from the commits, which is the only
  // source there is: §3 gives this action one button and no form. `--base` is
  // passed only when this worktree recorded one; without it GitHub's own
  // default for the repository stands, and what it chose is read back below.
  const base = await readRecordedPullRequestBase(workDir, branch, upstream, runGit);
  const created = await runGh(
    [
      "pr", "create", "--repo", repository, "--head", branch,
      ...(base ? ["--base", base] : []),
      "--fill",
    ],
    { cwd: workDir },
  );
  if (created.exitCode !== 0) {
    const originalFailure = describeGhFailure(created);
    // A PR may have appeared after the preflight and before GitHub handled the
    // create. Re-read once; finding it makes this request an idempotent success
    // without relying on localized `already exists` stderr.
    const raced = await readExistingOpenPullRequest(
      workDir,
      repository,
      branch,
      runGh,
    );
    if (raced.kind === "found") {
      return {
        ok: true,
        outcome: {
          action: "create_pr",
          disposition: "existing",
          branch,
          url: raced.pullRequest.url,
          number: raced.pullRequest.number,
          baseBranch: raced.pullRequest.baseRefName,
        },
      };
    }
    return { ok: false, failure: originalFailure };
  }

  const opened = await readOpenedPullRequest(workDir, repository, branch, runGh);
  return {
    ok: true,
    outcome: {
      action: "create_pr",
      disposition: "created",
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

type ExistingOpenPullRequestResult =
  | { kind: "found"; pullRequest: OpenedPullRequest }
  | { kind: "none" }
  | { kind: "failure"; failure: GitActionFailure };

async function readExistingOpenPullRequest(
  workDir: string,
  repository: string,
  branch: string,
  runGh: GhRunner,
): Promise<ExistingOpenPullRequestResult> {
  const listed = await runGh(
    [
      "pr", "list", "--repo", repository, "--head", branch,
      "--state", "open", "--json", "number,url,baseRefName", "--limit", "1",
    ],
    { cwd: workDir },
  ).catch((error: unknown) => ({
    exitCode: null,
    stdout: "",
    stderr: error instanceof Error ? error.message : String(error),
  }));
  if (listed.exitCode !== 0) {
    return { kind: "failure", failure: describeGhFailure(listed) };
  }

  let payload: unknown;
  try {
    payload = JSON.parse(listed.stdout);
  } catch {
    return {
      kind: "failure",
      failure: describeMalformedGhPayload("gh returned malformed open-PR JSON", listed),
    };
  }
  if (!Array.isArray(payload)) {
    return {
      kind: "failure",
      failure: describeMalformedGhPayload("gh returned a non-array open-PR payload", listed),
    };
  }
  if (payload.length === 0) return { kind: "none" };

  const first = payload[0];
  if (!first || typeof first !== "object") {
    return {
      kind: "failure",
      failure: describeMalformedGhPayload("gh returned an invalid open PR", listed),
    };
  }
  const row = first as Record<string, unknown>;
  if (
    typeof row.number !== "number"
    || !Number.isInteger(row.number)
    || typeof row.url !== "string"
    || typeof row.baseRefName !== "string"
  ) {
    return {
      kind: "failure",
      failure: describeMalformedGhPayload("gh returned incomplete open-PR details", listed),
    };
  }

  return {
    kind: "found",
    pullRequest: {
      number: row.number,
      url: row.url,
      baseRefName: row.baseRefName,
    },
  };
}

function describeMalformedGhPayload(
  message: string,
  result: GhCommandResult,
): GitActionFailure {
  return {
    kind: "command_failed",
    message,
    stderr: truncateStderr(result.stderr),
    stdout: truncateStderr(result.stdout),
    exitCode: result.exitCode,
    changedFiles: [],
  };
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

  const upstream = await readUpstream(target.workDir, runGit, branch);
  if (!upstream) {
    // The ladder only offers Pull on a branch that is behind something, which
    // takes an upstream; this is the handler-side guard for a click that raced
    // the state it was derived from.
    //
    // It stays a rejection rather than becoming "nothing to pull": a pull that
    // cannot name where it would pull from has not established that there is
    // nothing to bring in, and reporting it as a no-op would leave the branch
    // silently behind. The panel now resolves an upstream from config too, so
    // reaching here means the branch genuinely tracks nothing.
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

/** Which Git command unwinds each operation. There is one per operation. */
const ABORT_ARGS: Record<GitConflictOperation, string[]> = {
  merge: ["merge", "--abort"],
  rebase: ["rebase", "--abort"],
  cherry_pick: ["cherry-pick", "--abort"],
};

/**
 * The escape of `docs/design/git-delivery.md` §9: whatever the worktree is stuck
 * part-way through, put it back the way it was.
 *
 * The operation is detected here rather than taken from the request. The panel
 * detected one too, in order to draw the label — but the panel is polled, and a
 * worktree can change hands between the draw and the press. Re-reading is what
 * keeps the command matched to the state it actually runs against; running
 * `git merge --abort` on a rebase would fail, and running it on a *later* merge
 * the user started meanwhile would throw away work they never asked to lose.
 */
async function runAbort(
  target: GitActionTarget,
  runGit: GitRunner,
): Promise<GitActionResult> {
  // The repository root, not the working directory: the markers live beside the
  // worktree's own git directory, and a session's working directory is allowed
  // to be a directory inside it. Probing the working directory would find no
  // `.git` there and refuse an abort the panel had just offered — the one thing
  // §9 promises is that the user can always get out.
  //
  // `--show-toplevel` costs a Git process, which the panel's detection is not
  // allowed to spend but this one is: an abort is already running Git, and the
  // panel is the read that has to stay cheap.
  const repoRoot = await readRepoRoot(target.workDir, runGit);
  const operation = await detectGitConflictOperation(
    repoRoot,
    target.agentEnvironment,
  );
  if (!operation) {
    // The menu lists this entry only while an operation is detected; this is the
    // handler-side guard for a press that raced the state it was drawn from.
    throw new GitActionRejection(
      "no_conflict_in_progress",
      "This worktree has no merge, rebase or cherry-pick to abort",
    );
  }

  try {
    await runGit(ABORT_ARGS[operation], { cwd: target.workDir });
  } catch (error) {
    // No hook promotion: an abort runs none. What it does fail on is a worktree
    // Git will not unwind — an index another process is holding, a file it
    // cannot restore — and the runner's own classification says that best.
    return {
      ok: false,
      failure: await describeFailure(error, target, runGit, (failed) => failed.kind),
    };
  }

  return {
    ok: true,
    outcome: {
      action: "abort",
      operation,
      // After the abort, not before: a rebase runs on a detached HEAD, so the
      // branch the user is back on is only readable once the unwind is done.
      branch: await readCurrentBranch(target.workDir, runGit),
    },
  };
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

/**
 * Where the worktree actually starts. Falls back to the working directory when
 * Git will not say, which leaves the caller exactly where it would have been.
 */
async function readRepoRoot(workDir: string, runGit: GitRunner): Promise<string> {
  const result = await runGit(["rev-parse", "--show-toplevel"], {
    cwd: workDir,
    timeoutMs: PROBE_TIMEOUT_MS,
  }).catch(() => null);

  return result?.stdout.trim() || workDir;
}

/**
 * A ref as `gh` wants it: the branch name, with whatever qualified it removed.
 * Matches Orca's `normalizeHostedReviewBaseRef`, which the values written into
 * this key are already shaped by.
 */
function normalizeBaseRefName(ref: string): string {
  return ref
    .trim()
    .replace(/^refs\/heads\//, "")
    .replace(/^refs\/remotes\/[^/]+\//, "")
    .replace(/^(origin|upstream)\//, "");
}

/**
 * The base this worktree was cut from, or null when there is none worth passing.
 *
 * Orca and t3code both hand the pull request the worktree's own base rather
 * than letting the host choose (`--base` in `github/client.ts`, `baseRefName`
 * from `prepareWorktree.baseBranch`). The case it decides is a branch cut from
 * another branch: left to GitHub it opens against the repository default, and
 * the diff carries every commit of the parent along with its own.
 *
 * Three things have to hold. There has to be a recorded base — a branch made
 * outside Tessera has none, and Git remembers nothing by itself. It has to name
 * something other than this branch, which GitHub would refuse. And it has to
 * exist on the remote, because `gh` resolves the base there: a parent that
 * never left this machine fails the whole call, where falling back to the
 * default merely opens a wider pull request.
 */
async function readRecordedPullRequestBase(
  workDir: string,
  branch: string,
  upstream: string,
  runGit: GitRunner,
): Promise<string | null> {
  const recorded = await runGit(
    ["config", "--get", `branch.${branch}.base`],
    { cwd: workDir, timeoutMs: PROBE_TIMEOUT_MS },
  ).catch(() => null);

  const base = normalizeBaseRefName(recorded?.stdout ?? "");
  if (!base || base === branch) return null;

  const remote = upstream.split("/", 1)[0]?.trim() || "origin";
  const onRemote = await runGit(
    ["show-ref", "--verify", "--quiet", `refs/remotes/${remote}/${base}`],
    { cwd: workDir, timeoutMs: PROBE_TIMEOUT_MS },
  ).catch(() => null);

  return onRemote ? base : null;
}

/**
 * The branch this one tracks, or null when it tracks nothing.
 *
 * `@{upstream}` is asked first because it is the one answer Git itself vouches
 * for, and the config pair second because `@{upstream}` is resolved through the
 * fetch refspec: a clone narrowed to a couple of branches refuses it for every
 * other branch, published or not (`upstream-config.ts`). Reading that refusal as
 * "no upstream" is what made `runPush` pass `--set-upstream` to a branch that
 * already had one, forever.
 *
 * `branch` comes from the caller because every caller has already read it, and
 * this is a fallback path that should not spend a process re-reading it.
 */
async function readUpstream(
  workDir: string,
  runGit: GitRunner,
  branch: string | null,
): Promise<string | null> {
  const result = await runGit(
    ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
    { cwd: workDir, timeoutMs: PROBE_TIMEOUT_MS },
  ).catch(() => null);

  const resolved = result?.stdout.trim();
  if (resolved) return resolved;

  return (await readConfiguredUpstream(workDir, runGit, branch))?.name ?? null;
}

/** What `branch.<name>.remote` and `branch.<name>.merge` say, or null. */
async function readConfiguredUpstream(
  workDir: string,
  runGit: GitRunner,
  branch: string | null,
): Promise<ConfiguredUpstream | null> {
  if (!branch) return null;

  const result = await runGit(
    ["config", "--get-regexp", "^branch\\..*\\.(remote|merge)$"],
    { cwd: workDir, timeoutMs: PROBE_TIMEOUT_MS },
  ).catch(() => null);

  return resolveConfiguredUpstream(result?.stdout ?? null, branch);
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
