import { readFile } from "fs/promises";
import path from "path";
import {
  getFilesystemPathBasename,
  resolveWslDisplayPathAgainstWindowsHostedPath,
} from "@/lib/filesystem/path-environment";
import { resolvePathForHostFilesystem } from "@/lib/filesystem/host-path";
import * as dbSessions from "@/lib/db/sessions";
import * as dbTasks from "@/lib/db/tasks";
import { getCachedSessionPr } from "@/lib/github/session-pr-sync";
import {
  computeWorktreeFileDiffStats,
  computeWorktreeFileDiffStatsFromRaw,
} from "@/lib/git/worktree-diff-stats";
import {
  getCachedDiffStats,
  getCachedDiffStatsRevalidating,
} from "@/lib/git/worktree-diff-stats-cache";
import {
  createGitRunner,
  createGitShellRunner,
  GitCommandError,
  looksLikeFilesystemPath,
} from "@/lib/worktrees/git-runner";
import {
  resolveGitEnvironment,
  type GitEnvironmentSource,
} from "@/lib/git/git-environment";
import { parseGitStatus } from "@/lib/git/git-status";
import type { GitActionTarget } from "@/lib/git/git-actions";
import { getManagedWorktreeRelativeDisplayPath } from "@/lib/worktrees/managed";
import { getRuntimePlatform } from "@/lib/system/runtime-platform";
import type { AgentEnvironment } from "@/lib/settings/types";
import type {
  GitChangedFile,
  GitChangedFilesData,
  GitChecksSummary,
  GitCommitSummary,
  GitDiffData,
  GitPanelData,
} from "@/types/git";

const COMMAND_MAX_BUFFER = 4 * 1024 * 1024;
const BATCH_COMMAND_MAX_BUFFER = 24 * 1024 * 1024;
const MAX_SYNTHETIC_DIFF_BYTES = 64 * 1024;
const COMMAND_TIMEOUT_MS = 10_000;
// Upper bound on how many changed-file rows we serialize to the client and
// render. When something like an unignored `.venv` produces tens of thousands
// of untracked files, sending and rendering them all freezes the git panel;
// we cap the list and surface the true total via `changedFilesTruncated`.
const MAX_CHANGED_FILES = 1000;
// `git status -z` emits one NUL per path (renames/copies emit two). Once we've
// streamed past this many NULs we already have more than enough entries to know
// the list overflows `MAX_CHANGED_FILES`, so we kill git before it walks the
// rest of a huge untracked tree (e.g. an unignored `.venv`).
const STATUS_STREAM_NUL_LIMIT = (MAX_CHANGED_FILES + 1) * 2;

interface ChangedFilesResult {
  files: GitChangedFile[];
  /**
   * Total changed-file count. Omitted when the status stream was cut short
   * early (`truncated` via `stoppedEarly`), in which case the true total is
   * unknown — only that it exceeds what we display.
   */
  total?: number;
  truncated: boolean;
}

export class GitPanelError extends Error {
  readonly code:
    | "session_not_found"
    | "missing_work_dir"
    | "not_git_repo"
    | "invalid_file_path"
    | "command_failed"
    | "command_timeout";
  readonly status: number;
  /**
   * The runner failure this was translated from, when there was one. ADR 0005
   * requires the execution layer to keep the classified kind, the exit code and
   * the raw stderr rather than flatten them into a message string, so the
   * translation to an HTTP-shaped error must not be where they are lost.
   */
  readonly gitError?: GitCommandError;

  constructor(
    code: GitPanelError["code"],
    message: string,
    status = 500,
    gitError?: GitCommandError,
  ) {
    super(message);
    this.code = code;
    this.status = status;
    if (gitError) this.gitError = gitError;
  }
}

/**
 * Every Git command in this file goes through the one runner
 * (`docs/design/git-delivery.md` §10). What the panel adds on top is its own
 * error type: routes answer from `GitPanelError.status`, so a runner failure is
 * translated here rather than escaping as-is.
 */
function toGitPanelError(error: unknown, command: string): GitPanelError {
  if (error instanceof GitPanelError) return error;
  if (error instanceof GitCommandError) {
    if (error.kind === "timeout") {
      return new GitPanelError(
        "command_timeout",
        `${command} did not respond within ${COMMAND_TIMEOUT_MS / 1000}s and was terminated`,
        504,
        error,
      );
    }
    // The runner already put stderr in the message; the exit code and the
    // classified kind ride along on `gitError` for a caller that wants them.
    return new GitPanelError("command_failed", error.message, 500, error);
  }
  const message = error instanceof Error ? error.message : String(error);
  return new GitPanelError("command_failed", message || `Failed to run ${command}`, 500);
}

async function runGitCommand(
  args: string[],
  cwd: string,
  agentEnvironment: AgentEnvironment,
  maxOutputBytes = COMMAND_MAX_BUFFER,
): Promise<string> {
  const runGit = createGitRunner(agentEnvironment, {
    timeoutMs: COMMAND_TIMEOUT_MS,
    maxOutputBytes,
  });
  try {
    const { stdout } = await runGit(args, { cwd });
    return stdout;
  } catch (error) {
    throw toGitPanelError(error, "git");
  }
}

export interface GitBatchCommand {
  key: string;
  args: string[];
}

interface GitBatchResult {
  stdout: string;
}

function quotePosixShellArg(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function buildGitBatchScript(commands: GitBatchCommand[]): string {
  for (const command of commands) {
    if (!/^[a-z][a-zA-Z0-9]*$/.test(command.key)) {
      throw new Error(`Invalid git batch key: ${command.key}`);
    }
    // The runner translates path arguments per argument; it cannot reach inside
    // this script. Batching is only ever used on a bridged setup, so a path
    // smuggled in here would break in the one configuration that is hardest to
    // notice. Keep the batch path-free and let the caller run it unbatched.
    const pathArg = command.args.find(looksLikeFilesystemPath);
    if (pathArg) {
      throw new Error(`Batched git commands cannot carry a path argument: ${pathArg}`);
    }
  }

  return [
    "command -v base64 >/dev/null 2>&1 || exit 69",
    "command -v tr >/dev/null 2>&1 || exit 69",
    ...commands.flatMap((command) => [
      `printf ${quotePosixShellArg(`${command.key}\tb64:`)}`,
      [
        "git",
        ...command.args.map(quotePosixShellArg),
        "2>/dev/null",
        "| base64 | tr -d '\\r\\n'",
      ].join(" "),
      "printf '\\n'",
    ]),
  ].join("\n");
}

function parseGitBatchOutput(
  raw: string,
  commands: GitBatchCommand[],
): Map<string, GitBatchResult> {
  const expectedKeys = new Set(commands.map((command) => command.key));
  const results = new Map<string, GitBatchResult>();

  for (const line of raw.split("\n")) {
    if (!line) continue;
    const firstTab = line.indexOf("\t");
    if (firstTab <= 0) {
      throw new GitPanelError("command_failed", "Invalid batched git output", 500);
    }

    const key = line.slice(0, firstTab);
    const encodedField = line.slice(firstTab + 1);
    if (
      !expectedKeys.has(key)
      || !encodedField.startsWith("b64:")
    ) {
      throw new GitPanelError("command_failed", "Invalid batched git result", 500);
    }
    const encoded = encodedField.slice(4);

    results.set(key, {
      stdout: Buffer.from(encoded, "base64").toString("utf8").trimEnd(),
    });
  }

  if (results.size !== expectedKeys.size) {
    throw new GitPanelError("command_failed", "Incomplete batched git output", 500);
  }

  return results;
}

async function runGitBatch(
  commands: GitBatchCommand[],
  cwd: string,
  agentEnvironment: AgentEnvironment,
): Promise<Map<string, GitBatchResult>> {
  const runGitShell = createGitShellRunner(agentEnvironment, {
    timeoutMs: COMMAND_TIMEOUT_MS,
    maxOutputBytes: BATCH_COMMAND_MAX_BUFFER,
  });
  let raw: string;
  try {
    raw = (await runGitShell(buildGitBatchScript(commands), { cwd })).stdout;
  } catch (error) {
    throw toGitPanelError(error, "git");
  }
  return parseGitBatchOutput(raw, commands);
}

function getOptionalBatchOutput(
  results: Map<string, GitBatchResult>,
  key: string,
): string | null {
  const result = results.get(key);
  return result?.stdout ?? null;
}

function shouldBatchGitCommands(agentEnvironment: AgentEnvironment): boolean {
  return agentEnvironment === "wsl" && getRuntimePlatform() === "win32";
}

async function runOptionalGitCommand(
  args: string[],
  cwd: string,
  agentEnvironment: AgentEnvironment,
): Promise<string | null> {
  try {
    return await runGitCommand(args, cwd, agentEnvironment);
  } catch (error) {
    // An expected failure (no upstream, not a repo, ...) degrades to null,
    // but a timed-out command must surface as 504 — swallowing it would
    // misreport a hung git as an empty result (e.g. 404 "not in change set").
    if (error instanceof GitPanelError && error.status === 504) throw error;
    return null;
  }
}

interface StreamedStatus {
  stdout: string;
  /** True when we stopped git early, or when its output passed the runner's cap. */
  stoppedEarly: boolean;
}

// Stream `git status -z`, counting NUL delimiters as they arrive. Once we pass
// `nulLimit` we ask the runner to stop instead of letting git enumerate a
// massive untracked tree and buffer megabytes we'd only throw away. Returns
// whatever was collected plus whether we stopped it early.
async function runStatusStreaming(
  workDir: string,
  agentEnvironment: AgentEnvironment,
  nulLimit: number,
): Promise<StreamedStatus> {
  const runGit = createGitRunner(agentEnvironment, {
    timeoutMs: COMMAND_TIMEOUT_MS,
    maxOutputBytes: BATCH_COMMAND_MAX_BUFFER,
  });
  let nulCount = 0;

  try {
    const result = await runGit(
      ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
      {
        cwd: workDir,
        onStdout: (chunk) => {
          for (let i = 0; i < chunk.length; i++) {
            if (chunk[i] === 0) nulCount++;
          }
          return nulCount > nulLimit ? "stop" : undefined;
        },
      },
    );
    // A capped read is the same situation as a stopped one: a partial list and
    // no honest total. Reporting only `stoppedEarly` would let a cut-off status
    // read look like a genuinely small change set.
    return {
      stdout: result.stdout,
      stoppedEarly: result.stoppedEarly || result.truncated,
    };
  } catch (error) {
    throw toGitPanelError(error, "git status");
  }
}

interface GitSessionContext {
  workDir: string;
  taskId: string | null;
  worktreeBranch: string | null;
}

async function resolveSessionContext(sessionId: string): Promise<GitSessionContext> {
  const session = dbSessions.getSessionWorktreeContext(sessionId);
  if (!session)
    throw new GitPanelError("session_not_found", "Session not found", 404);
  if (!session.workDir)
    throw new GitPanelError(
      "missing_work_dir",
      "Session has no working directory",
      422,
    );
  return {
    workDir: session.workDir,
    taskId: session.taskId,
    worktreeBranch: session.worktreeBranch,
  };
}

async function resolveSessionWorkDir(sessionId: string): Promise<string> {
  const context = await resolveSessionContext(sessionId);
  return context.workDir;
}

/**
 * Where a Git action for this session runs. The execution module deliberately
 * does not resolve sessions, so route handlers come through here instead of
 * accepting a worktree path from the client.
 */
export async function resolveSessionGitTarget(
  sessionId: string,
  userId: string,
): Promise<GitActionTarget> {
  const workDir = await resolveSessionWorkDir(sessionId);
  return {
    workDir,
    agentEnvironment: await resolveGitEnvironment({ userId }),
  };
}

async function resolveRepoRoot(
  workDir: string,
  agentEnvironment: AgentEnvironment,
): Promise<string> {
  const isRepo = await runOptionalGitCommand(
    ["rev-parse", "--is-inside-work-tree"],
    workDir,
    agentEnvironment,
  );
  if (isRepo !== "true") {
    throw new GitPanelError(
      "not_git_repo",
      "Working directory is not a git repository",
      422,
    );
  }
  return runGitCommand(["rev-parse", "--show-toplevel"], workDir, agentEnvironment);
}

export function getWorktreeDisplayName(workDir: string): string {
  const managedRelative = getManagedWorktreeRelativeDisplayPath(workDir);
  if (managedRelative) {
    return managedRelative;
  }

  const pathModule = getPathModule(workDir);
  return pathModule.basename(pathModule.resolve(workDir));
}

function parseAheadBehind(raw: string | null): {
  ahead: number;
  behind: number;
} {
  if (!raw) return { ahead: 0, behind: 0 };
  const [aheadRaw, behindRaw] = raw.trim().split(/\s+/);
  const ahead = Number.parseInt(aheadRaw ?? "0", 10);
  const behind = Number.parseInt(behindRaw ?? "0", 10);
  return {
    ahead: Number.isFinite(ahead) ? ahead : 0,
    behind: Number.isFinite(behind) ? behind : 0,
  };
}

export function parseRecentCommits(stdout: string): GitCommitSummary[] {
  if (!stdout.trim()) return [];
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [oidShort = "", subject = "", relativeDate = ""] = line.split("\t");
      return { oidShort, subject, relativeDate };
    });
}

export function normalizeGithubUrl(remoteUrl: string | null): string | null {
  if (!remoteUrl) return null;

  const sshMatch = remoteUrl.match(/^git@github\.com:(.+?)(?:\.git)?$/);
  if (sshMatch?.[1]) return `https://github.com/${sshMatch[1]}`;

  const httpsMatch = remoteUrl.match(
    /^https?:\/\/github\.com\/(.+?)(?:\.git)?$/,
  );
  if (httpsMatch?.[1]) return `https://github.com/${httpsMatch[1]}`;

  return null;
}

export function summarizeStatusCheckRollup(items: unknown[]): GitChecksSummary {
  const checks: GitChecksSummary = {
    total: items.length,
    passing: 0,
    failing: 0,
    pending: 0,
  };

  for (const item of items) {
    const candidate = item as Record<string, unknown>;
    const rawState = String(
      candidate.conclusion ?? candidate.state ?? candidate.status ?? "",
    ).toUpperCase();

    if (["SUCCESS", "NEUTRAL", "SKIPPED"].includes(rawState)) {
      checks.passing += 1;
      continue;
    }
    if (
      [
        "FAILURE",
        "ERROR",
        "TIMED_OUT",
        "ACTION_REQUIRED",
        "STARTUP_FAILURE",
        "CANCELLED",
      ].includes(rawState)
    ) {
      checks.failing += 1;
      continue;
    }
    checks.pending += 1;
  }

  return checks;
}

function resolveGitHubPanelState(
  remoteUrl: string | null,
  prSummary: { wasUnsupported: boolean; prStatus?: unknown } | null,
): GitPanelData["github"] {
  if (!normalizeGithubUrl(remoteUrl)) {
    return {
      available: false,
      reasonCode: "not_github_remote",
      reason: "Add a GitHub origin remote to create pull requests.",
      pullRequest: null,
    };
  }

  if (!prSummary) {
    return {
      available: false,
      reasonCode: "unknown",
      reason: "GitHub status will update shortly.",
      pullRequest: null,
    };
  }

  if (prSummary.wasUnsupported) {
    return {
      available: false,
      reasonCode: "unknown",
      reason: "GitHub PR sync is unavailable for this session.",
      pullRequest: null,
    };
  }

  return {
    available: true,
    reasonCode: prSummary.prStatus ? null : "no_pull_request",
    reason: prSummary.prStatus
      ? null
      : "No pull request is linked to the current branch.",
    pullRequest: null,
  };
}

function getDefaultBranchName(raw: string | null): string | null {
  if (!raw) return null;
  const match = raw.trim().match(/refs\/remotes\/origin\/(.+)$/);
  return match?.[1] ?? null;
}

function getRecentCommitArgs(hasUpstream: boolean): string[] {
  const baseArgs = ["log", "--format=%h%x09%s%x09%cr", "--date-order", "-n", "5"];
  return hasUpstream ? [...baseArgs, "HEAD", "@{upstream}"] : baseArgs;
}

function getFetchRemoteName(upstream: string | null): string {
  const remote = upstream?.split("/", 1)[0]?.trim();
  return remote || "origin";
}

async function getChangedFiles(
  workDir: string,
  agentEnvironment: AgentEnvironment,
): Promise<ChangedFilesResult> {
  const [status, fileDiffStats] = await Promise.all([
    runStatusStreaming(workDir, agentEnvironment, STATUS_STREAM_NUL_LIMIT),
    computeWorktreeFileDiffStats(workDir, agentEnvironment),
  ]);
  return attachFileDiffStats(status.stdout, fileDiffStats, status.stoppedEarly);
}

function attachFileDiffStats(
  statusRaw: string | null,
  fileDiffStats: Map<string, { added: number; removed: number }> | null,
  stoppedEarly = false,
): ChangedFilesResult {
  const statsByPath = fileDiffStats ?? new Map();
  const parsed = parseGitStatus(statusRaw ?? "");
  const truncated = stoppedEarly || parsed.length > MAX_CHANGED_FILES;
  const limited = truncated ? parsed.slice(0, MAX_CHANGED_FILES) : parsed;
  const files = limited.map((file) => {
    const diffStats = statsByPath.get(file.path);
    return diffStats ? { ...file, diffStats } : file;
  });
  // When we killed git early the parsed count is only a lower bound, so leave
  // `total` unset — the client shows "first N, many more" instead of a wrong number.
  return { files, total: stoppedEarly ? undefined : parsed.length, truncated };
}

interface GitPanelSnapshot {
  repoRoot: string;
  branchRaw: string | null;
  upstream: string | null;
  aheadBehindRaw: string | null;
  remoteUrl: string | null;
  defaultBranchRaw: string | null;
  branchListRaw: string | null;
  changedFiles: ChangedFilesResult;
  recentCommitsRaw: string | null;
  detachedHead: string | null;
  headShaRaw: string | null;
}

function getChangedFilesBatchCommands(): GitBatchCommand[] {
  return [
    { key: "repoRoot", args: ["rev-parse", "--show-toplevel"] },
    {
      key: "status",
      args: ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    },
    { key: "numstat", args: ["diff", "--numstat", "HEAD", "--"] },
    {
      key: "untracked",
      args: ["ls-files", "--others", "--exclude-standard", "-z"],
    },
  ];
}

function getGitPanelBatchCommands(): GitBatchCommand[] {
  return [
    ...getChangedFilesBatchCommands(),
    { key: "branch", args: ["branch", "--show-current"] },
    {
      key: "upstream",
      args: ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
    },
    {
      key: "aheadBehind",
      args: ["rev-list", "--left-right", "--count", "HEAD...@{upstream}"],
    },
    { key: "remoteUrl", args: ["remote", "get-url", "origin"] },
    {
      key: "defaultBranch",
      args: ["symbolic-ref", "refs/remotes/origin/HEAD"],
    },
    {
      key: "branchList",
      args: ["branch", "-a", "--format=%(refname:short)"],
    },
    { key: "recentLocal", args: getRecentCommitArgs(false) },
    { key: "recentUpstream", args: getRecentCommitArgs(true) },
    { key: "detachedHead", args: ["rev-parse", "--short", "HEAD"] },
    { key: "headSha", args: ["rev-parse", "HEAD"] },
  ];
}

function requireBatchedRepoRoot(results: Map<string, GitBatchResult>): string {
  const repoRoot = getOptionalBatchOutput(results, "repoRoot");
  if (!repoRoot) {
    throw new GitPanelError(
      "not_git_repo",
      "Working directory is not a git repository",
      422,
    );
  }
  return repoRoot;
}

async function getBatchedChangedFiles(
  workDir: string,
  agentEnvironment: AgentEnvironment,
): Promise<{ repoRoot: string; changedFiles: ChangedFilesResult }> {
  const commands = getChangedFilesBatchCommands();
  const results = await runGitBatch(commands, workDir, agentEnvironment);
  const repoRoot = requireBatchedRepoRoot(results);
  const statusRaw = getOptionalBatchOutput(results, "status");
  const fileDiffStats = await computeWorktreeFileDiffStatsFromRaw(
    workDir,
    getOptionalBatchOutput(results, "numstat"),
    getOptionalBatchOutput(results, "untracked"),
  );
  return {
    repoRoot,
    changedFiles: attachFileDiffStats(statusRaw, fileDiffStats),
  };
}

async function getBatchedGitPanelSnapshot(
  workDir: string,
  agentEnvironment: AgentEnvironment,
): Promise<GitPanelSnapshot> {
  const commands = getGitPanelBatchCommands();
  const results = await runGitBatch(commands, workDir, agentEnvironment);
  const repoRoot = requireBatchedRepoRoot(results);
  const upstream = getOptionalBatchOutput(results, "upstream");
  const fileDiffStats = await computeWorktreeFileDiffStatsFromRaw(
    workDir,
    getOptionalBatchOutput(results, "numstat"),
    getOptionalBatchOutput(results, "untracked"),
  );

  return {
    repoRoot,
    branchRaw: getOptionalBatchOutput(results, "branch"),
    upstream,
    aheadBehindRaw: getOptionalBatchOutput(results, "aheadBehind"),
    remoteUrl: getOptionalBatchOutput(results, "remoteUrl"),
    defaultBranchRaw: getOptionalBatchOutput(results, "defaultBranch"),
    branchListRaw: getOptionalBatchOutput(results, "branchList"),
    changedFiles: attachFileDiffStats(
      getOptionalBatchOutput(results, "status"),
      fileDiffStats,
    ),
    recentCommitsRaw: getOptionalBatchOutput(
      results,
      upstream ? "recentUpstream" : "recentLocal",
    ),
    detachedHead: getOptionalBatchOutput(results, "detachedHead"),
    headShaRaw: getOptionalBatchOutput(results, "headSha"),
  };
}

async function getSeparateGitPanelSnapshot(
  workDir: string,
  agentEnvironment: AgentEnvironment,
): Promise<GitPanelSnapshot> {
  const repoRoot = await resolveRepoRoot(workDir, agentEnvironment);
  const upstreamPromise = runOptionalGitCommand(
    ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
    workDir,
    agentEnvironment,
  );
  const recentCommitsPromise = upstreamPromise.then((currentUpstream) =>
    runOptionalGitCommand(
      getRecentCommitArgs(Boolean(currentUpstream)),
      workDir,
      agentEnvironment,
    ),
  );

  const [
    branchRaw,
    upstream,
    aheadBehindRaw,
    remoteUrl,
    defaultBranchRaw,
    branchListRaw,
    changedFiles,
    recentCommitsRaw,
  ] = await Promise.all([
    runOptionalGitCommand(["branch", "--show-current"], workDir, agentEnvironment),
    upstreamPromise,
    runOptionalGitCommand(
      ["rev-list", "--left-right", "--count", "HEAD...@{upstream}"],
      workDir,
      agentEnvironment,
    ),
    runOptionalGitCommand(["remote", "get-url", "origin"], workDir, agentEnvironment),
    runOptionalGitCommand(
      ["symbolic-ref", "refs/remotes/origin/HEAD"],
      workDir,
      agentEnvironment,
    ),
    runOptionalGitCommand(
      ["branch", "-a", "--format=%(refname:short)"],
      workDir,
      agentEnvironment,
    ),
    getChangedFiles(workDir, agentEnvironment),
    recentCommitsPromise,
  ]);

  const [detachedHead, headShaRaw] = await Promise.all([
    runOptionalGitCommand(["rev-parse", "--short", "HEAD"], workDir, agentEnvironment),
    runOptionalGitCommand(["rev-parse", "HEAD"], workDir, agentEnvironment),
  ]);

  return {
    repoRoot,
    branchRaw,
    upstream,
    aheadBehindRaw,
    remoteUrl,
    defaultBranchRaw,
    branchListRaw,
    changedFiles,
    recentCommitsRaw,
    detachedHead,
    headShaRaw,
  };
}

function getGitPanelSnapshot(
  workDir: string,
  agentEnvironment: AgentEnvironment,
): Promise<GitPanelSnapshot> {
  return shouldBatchGitCommands(agentEnvironment)
    ? getBatchedGitPanelSnapshot(workDir, agentEnvironment)
    : getSeparateGitPanelSnapshot(workDir, agentEnvironment);
}

function ensurePathInsideRepo(repoRoot: string, relativePath: string): string {
  if (!relativePath)
    throw new GitPanelError("invalid_file_path", "File path is required", 400);

  const pathModule = getPathModule(repoRoot);
  const resolved = pathModule.resolve(repoRoot, relativePath);
  const normalizedRoot = pathModule.resolve(repoRoot);
  const rootPrefix = normalizedRoot.endsWith(pathModule.sep)
    ? normalizedRoot
    : `${normalizedRoot}${pathModule.sep}`;

  if (resolved !== normalizedRoot && !resolved.startsWith(rootPrefix)) {
    throw new GitPanelError(
      "invalid_file_path",
      "File path escapes the repository root",
      400,
    );
  }

  return resolved;
}

async function buildSyntheticUntrackedDiff(
  repoRoot: string,
  relativePath: string,
  referenceFilesystemPath: string,
): Promise<string> {
  const filesystemRepoRoot = await resolveNodeFilesystemPath(
    repoRoot,
    referenceFilesystemPath,
  );
  const absolutePath = ensurePathInsideRepo(filesystemRepoRoot, relativePath);
  const buffer = await readFile(absolutePath);

  if (buffer.includes(0)) {
    return `diff --git a/${relativePath} b/${relativePath}\nBinary file added: ${relativePath}\n`;
  }

  const truncated = buffer.byteLength > MAX_SYNTHETIC_DIFF_BYTES;
  const text = buffer.subarray(0, MAX_SYNTHETIC_DIFF_BYTES).toString("utf8");
  const lines = text.split("\n");
  const hunkLines = lines.map((line) => `+${line}`).join("\n");
  const notice = truncated ? "\n+... diff truncated for preview" : "";

  return [
    `diff --git a/${relativePath} b/${relativePath}`,
    "new file mode 100644",
    "--- /dev/null",
    `+++ b/${relativePath}`,
    `@@ -0,0 +1,${lines.length} @@`,
    `${hunkLines}${notice}`,
  ].join("\n");
}

export async function getGitPanelData(
  sessionId: string,
  userId?: string,
): Promise<GitPanelData> {
  const sessionContext = await resolveSessionContext(sessionId);
  const { workDir } = sessionContext;
  const agentEnvironment = await resolveGitEnvironment(gitEnvironmentSourceFor(workDir, userId));
  const {
    repoRoot,
    branchRaw,
    upstream,
    aheadBehindRaw,
    remoteUrl,
    defaultBranchRaw,
    branchListRaw,
    changedFiles,
    recentCommitsRaw,
    detachedHead,
    headShaRaw,
  } = await getGitPanelSnapshot(workDir, agentEnvironment);
  const prContext = sessionContext.taskId
    ? dbTasks.getTaskPrSyncContext(sessionContext.taskId)
    : null;
  // PR detection can invoke remote git and gh commands. Keep the initial panel
  // read local-only and use the last cached result; the focus/turn-end/poller
  // refresh paths populate this cache and broadcast the updated panel state.
  const bareSessionPr = sessionContext.taskId
    ? null
    : getCachedSessionPr(sessionId) ?? null;
  const { ahead, behind } = parseAheadBehind(aheadBehindRaw);
  const prSummary = prContext
    ? { wasUnsupported: prContext.wasUnsupported, prStatus: prContext.prStatus }
    : bareSessionPr
      ? { wasUnsupported: bareSessionPr.prUnsupported, prStatus: bareSessionPr.prStatus }
      : null;
  const github = resolveGitHubPanelState(remoteUrl, prSummary);

  return {
    sessionId,
    ...(sessionContext.taskId ? { taskId: sessionContext.taskId } : {}),
    workDir,
    repoRoot,
    repoName: getFilesystemPathBasename(repoRoot),
    worktreeName: getWorktreeDisplayName(workDir),
    worktreePath: workDir,
    branch:
      branchRaw || (detachedHead ? `detached@${detachedHead}` : "unknown"),
    upstream,
    ahead,
    behind,
    remoteUrl,
    repoUrl: normalizeGithubUrl(remoteUrl),
    defaultBranch: getDefaultBranchName(defaultBranchRaw),
    branches: (branchListRaw ?? "")
      .split("\n")
      .map((b) => b.trim())
      .filter((b) => b && !b.includes("HEAD")),
    changedFiles: changedFiles.files,
    changedFilesTotal: changedFiles.total,
    changedFilesTruncated: changedFiles.truncated,
    recentCommits: parseRecentCommits(recentCommitsRaw ?? ""),
    github,
    // changedFiles below is always freshly probed, so serving a stale cached
    // diffStats next to it puts two contradicting numbers in one panel. Reading
    // through the revalidating accessor re-arms the cache whenever the panel is
    // opened, which is also the moment a user is most likely to notice a lie.
    diffStats: sessionContext.worktreeBranch
      ? (userId
        ? getCachedDiffStatsRevalidating(workDir, userId)
        : getCachedDiffStats(workDir)) ?? undefined
      : undefined,
    prStatus: prContext?.prStatus ?? bareSessionPr?.prStatus,
    prUnsupported:
      prContext?.wasUnsupported ?? bareSessionPr?.prUnsupported ?? false,
    remoteBranchExists:
      prContext?.remoteBranchExists ?? bareSessionPr?.remoteBranchExists,
    headSha: headShaRaw && /^[0-9a-f]{40}$/i.test(headShaRaw) ? headShaRaw : null,
  };
}

export async function getGitChangedFilesData(
  sessionId: string,
  userId?: string,
): Promise<GitChangedFilesData> {
  const workDir = await resolveSessionWorkDir(sessionId);
  const agentEnvironment = await resolveGitEnvironment(gitEnvironmentSourceFor(workDir, userId));
  let changedFiles: ChangedFilesResult;
  if (shouldBatchGitCommands(agentEnvironment)) {
    changedFiles = (await getBatchedChangedFiles(workDir, agentEnvironment)).changedFiles;
  } else {
    await resolveRepoRoot(workDir, agentEnvironment);
    changedFiles = await getChangedFiles(workDir, agentEnvironment);
  }

  return {
    sessionId,
    changedFiles: changedFiles.files,
    changedFilesTotal: changedFiles.total,
    changedFilesTruncated: changedFiles.truncated,
  };
}

export async function fetchGitPanelData(
  sessionId: string,
  userId?: string,
): Promise<GitPanelData> {
  const sessionContext = await resolveSessionContext(sessionId);
  const { workDir } = sessionContext;
  const agentEnvironment = await resolveGitEnvironment(gitEnvironmentSourceFor(workDir, userId));
  await resolveRepoRoot(workDir, agentEnvironment);
  const upstream = await runOptionalGitCommand(
    ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
    workDir,
    agentEnvironment,
  );
  const remoteName = getFetchRemoteName(upstream);
  await runGitCommand(["fetch", "--prune", remoteName], workDir, agentEnvironment);
  return getGitPanelData(sessionId, userId);
}

export async function getGitDiffData(
  sessionId: string,
  relativePath: string,
  userId?: string,
): Promise<GitDiffData> {
  const workDir = await resolveSessionWorkDir(sessionId);
  const agentEnvironment = await resolveGitEnvironment(gitEnvironmentSourceFor(workDir, userId));
  const repoRoot = await resolveRepoRoot(workDir, agentEnvironment);
  const changedFiles = await getChangedFiles(workDir, agentEnvironment);
  const fileEntry = changedFiles.files.find((file) => file.path === relativePath);

  if (!fileEntry) {
    throw new GitPanelError(
      "invalid_file_path",
      "File is not part of the current git change set",
      404,
    );
  }

  if (fileEntry.state === "untracked") {
    const diff = await buildSyntheticUntrackedDiff(repoRoot, relativePath, workDir);
    return {
      sessionId,
      workDir,
      path: relativePath,
      diff,
      truncated: diff.includes("diff truncated for preview"),
    };
  }

  const diff = await runOptionalGitCommand(
    [
      "diff",
      "--no-ext-diff",
      "--no-color",
      "--unified=3",
      "HEAD",
      "--",
      relativePath,
    ],
    repoRoot,
    agentEnvironment,
  );

  return {
    sessionId,
    workDir,
    path: relativePath,
    diff: diff || `No textual diff available for ${relativePath}.`,
    truncated: false,
  };
}

// `userId` is optional here because the recompute path (`git-panel-cache`)
// runs with no user attached.
function gitEnvironmentSourceFor(workDir: string, userId?: string): GitEnvironmentSource {
  return userId ? { userId } : { inferFromPaths: [workDir] };
}

async function resolveNodeFilesystemPath(
  gitPath: string,
  referenceFilesystemPath: string,
): Promise<string> {
  return resolveWslDisplayPathAgainstWindowsHostedPath(gitPath, referenceFilesystemPath)
    ?? resolvePathForHostFilesystem(gitPath);
}

function getPathModule(filesystemPath: string): typeof path.win32 | typeof path.posix {
  return isWindowsStylePath(filesystemPath) ? path.win32 : path.posix;
}

function isWindowsStylePath(filesystemPath: string): boolean {
  return (
    /^[a-zA-Z]:[\\/]/.test(filesystemPath)
    || /^[a-zA-Z]:$/.test(filesystemPath)
    || filesystemPath.startsWith("\\\\")
    || filesystemPath.startsWith("//")
  );
}
