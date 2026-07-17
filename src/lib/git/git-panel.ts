import type { SpawnOptions } from "child_process";
import { readFile } from "fs/promises";
import path from "path";
import {
  getFilesystemPathBasename,
  isWindowsHostedWslFilesystemPath,
  resolveWslDisplayPathAgainstWindowsHostedPath,
} from "@/lib/filesystem/path-environment";
import { resolvePathForHostFilesystem } from "@/lib/filesystem/host-path";
import * as dbSessions from "@/lib/db/sessions";
import * as dbTasks from "@/lib/db/tasks";
import { getCachedSessionPr, syncSessionPr } from "@/lib/github/session-pr-sync";
import { computeWorktreeFileDiffStats } from "@/lib/git/worktree-diff-stats";
import { getCachedDiffStats } from "@/lib/git/worktree-diff-stats-cache";
import { getAgentEnvironment, spawnCli } from "@/lib/cli/spawn-cli";
import { getManagedWorktreeRelativeDisplayPath } from "@/lib/worktrees/managed";
import { getRuntimePlatform } from "@/lib/system/runtime-platform";
import type { AgentEnvironment } from "@/lib/settings/types";
import type {
  GitChangedFile,
  GitChangedFilesData,
  GitChecksSummary,
  GitCommitSummary,
  GitDiffData,
  GitFileState,
  GitPanelData,
} from "@/types/git";

const COMMAND_MAX_BUFFER = 4 * 1024 * 1024;
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

  constructor(code: GitPanelError["code"], message: string, status = 500) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

async function runCommand(
  command: string,
  args: string[],
  cwd: string,
  agentEnvironment: AgentEnvironment,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const options: SpawnOptions = {
      cwd,
      // stdin is ignored, so a credential prompt would block the child
      // forever; tell git to fail instead of prompting.
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    };
    const child = spawnCli(command, args, options, agentEnvironment);
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutLength = 0;
    let stderrLength = 0;

    // Reject on our own timer instead of spawn's `timeout` option: waiting
    // for "close" is not enough, because a wedged grandchild (hook,
    // credential helper, fsmonitor) inherits the stdio pipes and keeps
    // "close" from firing even after the command itself is killed.
    const killTimer = setTimeout(() => {
      reject(new GitPanelError(
        "command_timeout",
        `${command} did not respond within ${COMMAND_TIMEOUT_MS / 1000}s and was terminated`,
        504,
      ));
      try {
        // detached spawn makes the command a group leader on POSIX; kill the
        // whole group so wedged grandchildren die with it.
        if (child.pid) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }, COMMAND_TIMEOUT_MS);

    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutLength += chunk.length;
      if (stdoutLength <= COMMAND_MAX_BUFFER) stdoutChunks.push(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrLength += chunk.length;
      if (stderrLength <= COMMAND_MAX_BUFFER) stderrChunks.push(chunk);
    });

    child.on("close", (code) => {
      clearTimeout(killTimer);
      const stdout = Buffer.concat(stdoutChunks).toString("utf8").trimEnd();
      const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();

      if (code === 0) {
        resolve(stdout);
        return;
      }

      reject(new GitPanelError("command_failed", stderr || `Failed to run ${command}`, 500));
    });

    child.on("error", (error) => {
      clearTimeout(killTimer);
      reject(new GitPanelError("command_failed", error.message || `Failed to run ${command}`, 500));
    });
  });
}

async function runOptionalCommand(
  command: string,
  args: string[],
  cwd: string,
  agentEnvironment: AgentEnvironment,
): Promise<string | null> {
  try {
    return await runCommand(command, args, cwd, agentEnvironment);
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
  stoppedEarly: boolean;
}

// Stream `git status -z`, counting NUL delimiters as they arrive. Once we pass
// `nulLimit` we kill the git process group instead of letting it enumerate a
// massive untracked tree and buffer megabytes we'd only throw away. Returns
// whatever was collected plus whether we stopped it early.
async function runStatusStreaming(
  workDir: string,
  agentEnvironment: AgentEnvironment,
  nulLimit: number,
): Promise<StreamedStatus> {
  return new Promise((resolve, reject) => {
    const options: SpawnOptions = {
      cwd: workDir,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    };
    const child = spawnCli(
      "git",
      ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
      options,
      agentEnvironment,
    );

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let nulCount = 0;
    let stoppedEarly = false;
    let settled = false;

    const killGroup = () => {
      try {
        // detached spawn makes the command a group leader on POSIX; kill the
        // whole group so wedged grandchildren die with it.
        if (child.pid) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };

    const finish = (result: StreamedStatus) => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      resolve(result);
    };

    const killTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      killGroup();
      reject(
        new GitPanelError(
          "command_timeout",
          `git status did not respond within ${COMMAND_TIMEOUT_MS / 1000}s and was terminated`,
          504,
        ),
      );
    }, COMMAND_TIMEOUT_MS);

    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutChunks.push(chunk);
      if (stoppedEarly) return;
      for (let i = 0; i < chunk.length; i++) {
        if (chunk[i] === 0) nulCount++;
      }
      if (nulCount > nulLimit) {
        stoppedEarly = true;
        killGroup();
        // Grandchildren holding the stdout pipe can delay "close"; resolve with
        // what we have shortly after killing rather than waiting out the timeout.
        setTimeout(() => {
          finish({
            stdout: Buffer.concat(stdoutChunks).toString("utf8"),
            stoppedEarly: true,
          });
        }, 500);
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderrChunks.length < 64) stderrChunks.push(chunk);
    });

    child.on("close", (code) => {
      if (stoppedEarly) {
        finish({
          stdout: Buffer.concat(stdoutChunks).toString("utf8"),
          stoppedEarly: true,
        });
        return;
      }
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      if (code === 0) {
        resolve({ stdout, stoppedEarly: false });
        return;
      }
      const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
      reject(
        new GitPanelError("command_failed", stderr || "Failed to run git status", 500),
      );
    });

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      reject(
        new GitPanelError(
          "command_failed",
          error.message || "Failed to run git status",
          500,
        ),
      );
    });
  });
}

interface GitSessionContext {
  workDir: string;
  taskId: string | null;
  worktreeBranch: string | null;
}

async function resolveSessionContext(sessionId: string): Promise<GitSessionContext> {
  const session = dbSessions.getSession(sessionId);
  if (!session)
    throw new GitPanelError("session_not_found", "Session not found", 404);
  if (!session.work_dir)
    throw new GitPanelError(
      "missing_work_dir",
      "Session has no working directory",
      422,
    );
  return {
    workDir: session.work_dir,
    taskId: session.task_id,
    worktreeBranch: session.worktree_branch,
  };
}

async function resolveSessionWorkDir(sessionId: string): Promise<string> {
  const context = await resolveSessionContext(sessionId);
  return context.workDir;
}

async function resolveRepoRoot(
  workDir: string,
  agentEnvironment: AgentEnvironment,
): Promise<string> {
  const isRepo = await runOptionalCommand(
    "git",
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
  return runCommand("git", ["rev-parse", "--show-toplevel"], workDir, agentEnvironment);
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

function inferFileState(
  indexStatus: string,
  workTreeStatus: string,
): GitFileState {
  const pair = `${indexStatus}${workTreeStatus}`;
  if (pair === "??") return "untracked";
  if (pair.includes("U") || pair === "AA" || pair === "DD") return "conflicted";
  if (indexStatus === "R" || workTreeStatus === "R") return "renamed";
  if (indexStatus === "C" || workTreeStatus === "C") return "copied";
  if (indexStatus === "A" || workTreeStatus === "A") return "added";
  if (indexStatus === "D" || workTreeStatus === "D") return "deleted";
  if (indexStatus === "T" || workTreeStatus === "T") return "typechange";
  if (indexStatus === "M" || workTreeStatus === "M") return "modified";
  return "unknown";
}

export function parseGitStatus(stdout: string): GitChangedFile[] {
  const tokens = stdout.split("\0").filter(Boolean);
  const files: GitChangedFile[] = [];
  let index = tokens[0]?.startsWith("## ") ? 1 : 0;

  while (index < tokens.length) {
    const entry = tokens[index];
    if (!entry || entry.length < 3) {
      index += 1;
      continue;
    }

    const indexStatus = entry[0] ?? " ";
    const workTreeStatus = entry[1] ?? " ";
    const pathValue = entry.slice(3);
    let previousPath: string | undefined;

    if (
      indexStatus === "R" ||
      workTreeStatus === "R" ||
      indexStatus === "C" ||
      workTreeStatus === "C"
    ) {
      previousPath = tokens[index + 1] || undefined;
      index += 1;
    }

    const state = inferFileState(indexStatus, workTreeStatus);
    const displayStatus = `${indexStatus}${workTreeStatus}`.trim() || "??";

    files.push({
      path: pathValue,
      ...(previousPath ? { previousPath } : {}),
      indexStatus,
      workTreeStatus,
      state,
      staged: indexStatus !== " " && indexStatus !== "?",
      unstaged: workTreeStatus !== " ",
      displayStatus,
    });

    index += 1;
  }

  return files;
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

async function resolveGitHubPanelState(
  workDir: string,
  remoteUrl: string | null,
  prSummary: { wasUnsupported: boolean; prStatus?: unknown } | null,
  agentEnvironment: AgentEnvironment,
): Promise<GitPanelData["github"]> {
  if (!normalizeGithubUrl(remoteUrl)) {
    return {
      available: false,
      reasonCode: "not_github_remote",
      reason: "Add a GitHub origin remote to create pull requests.",
      pullRequest: null,
    };
  }

  try {
    await runCommand("gh", ["--version"], workDir, agentEnvironment);
  } catch {
    return {
      available: false,
      reasonCode: "gh_missing",
      reason: "gh CLI is not available in this environment.",
      pullRequest: null,
    };
  }

  try {
    await runCommand("gh", ["auth", "status"], workDir, agentEnvironment);
  } catch {
    return {
      available: false,
      reasonCode: "gh_unauthenticated",
      reason: "GitHub CLI is installed, but it is not logged in. Run `gh auth login`, then refresh.",
      pullRequest: null,
    };
  }

  if (prSummary?.wasUnsupported) {
    return {
      available: false,
      reasonCode: "unknown",
      reason: "GitHub PR sync is unavailable for this session.",
      pullRequest: null,
    };
  }

  return {
    available: true,
    reasonCode: prSummary?.prStatus ? null : "no_pull_request",
    reason: prSummary?.prStatus
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
  const statsByPath = fileDiffStats ?? new Map();
  const parsed = parseGitStatus(status.stdout);
  const truncated = status.stoppedEarly || parsed.length > MAX_CHANGED_FILES;
  const limited = truncated ? parsed.slice(0, MAX_CHANGED_FILES) : parsed;
  const files = limited.map((file) => {
    const diffStats = statsByPath.get(file.path);
    return diffStats ? { ...file, diffStats } : file;
  });
  // When we killed git early the parsed count is only a lower bound, so leave
  // `total` unset — the client shows "first N, many more" instead of a wrong number.
  return { files, total: status.stoppedEarly ? undefined : parsed.length, truncated };
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
  const agentEnvironment = await resolveCommandEnvironment(workDir, userId);
  const repoRoot = await resolveRepoRoot(workDir, agentEnvironment);
  const prContext = sessionContext.taskId
    ? dbTasks.getTaskPrSyncContext(sessionContext.taskId)
    : null;
  // Bare sessions (no task) carry PR state in an in-memory cache populated
  // by syncSessionPr — same probe pipeline as tasks, just keyed by sessionId
  // since there's no task row to persist to. The cache is rebuilt on
  // restart, so on the first panel load we probe inline to avoid the panel
  // showing "no PR" until the next focus/poll tick.
  let bareSessionPr = sessionContext.taskId
    ? null
    : getCachedSessionPr(sessionId) ?? null;
  if (!sessionContext.taskId && !bareSessionPr && workDir) {
    try {
      await syncSessionPr(sessionId, { agentEnvironment });
      bareSessionPr = getCachedSessionPr(sessionId) ?? null;
    } catch {
      // Best-effort — the visibility refresh and poller will fill it in.
    }
  }

  const upstreamPromise = runOptionalCommand(
    "git",
    ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
    workDir,
    agentEnvironment,
  );
  const recentCommitsPromise = upstreamPromise.then((currentUpstream) =>
    runOptionalCommand(
      "git",
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
    runOptionalCommand("git", ["branch", "--show-current"], workDir, agentEnvironment),
    upstreamPromise,
    runOptionalCommand(
      "git",
      ["rev-list", "--left-right", "--count", "HEAD...@{upstream}"],
      workDir,
      agentEnvironment,
    ),
    runOptionalCommand("git", ["remote", "get-url", "origin"], workDir, agentEnvironment),
    runOptionalCommand(
      "git",
      ["symbolic-ref", "refs/remotes/origin/HEAD"],
      workDir,
      agentEnvironment,
    ),
    runOptionalCommand(
      "git",
      ["branch", "-a", "--format=%(refname:short)"],
      workDir,
      agentEnvironment,
    ),
    getChangedFiles(workDir, agentEnvironment),
    recentCommitsPromise,
  ]);

  const [detachedHead, headShaRaw] = await Promise.all([
    runOptionalCommand("git", ["rev-parse", "--short", "HEAD"], workDir, agentEnvironment),
    runOptionalCommand("git", ["rev-parse", "HEAD"], workDir, agentEnvironment),
  ]);
  const { ahead, behind } = parseAheadBehind(aheadBehindRaw);
  const prSummary = prContext
    ? { wasUnsupported: prContext.wasUnsupported, prStatus: prContext.prStatus }
    : bareSessionPr
      ? { wasUnsupported: bareSessionPr.prUnsupported, prStatus: bareSessionPr.prStatus }
      : null;
  const github = await resolveGitHubPanelState(workDir, remoteUrl, prSummary, agentEnvironment);

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
    diffStats: sessionContext.worktreeBranch
      ? getCachedDiffStats(workDir) ?? undefined
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
  const agentEnvironment = await resolveCommandEnvironment(workDir, userId);
  await resolveRepoRoot(workDir, agentEnvironment);

  const changedFiles = await getChangedFiles(workDir, agentEnvironment);
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
  const agentEnvironment = await resolveCommandEnvironment(workDir, userId);
  await resolveRepoRoot(workDir, agentEnvironment);
  const upstream = await runOptionalCommand(
    "git",
    ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
    workDir,
    agentEnvironment,
  );
  const remoteName = getFetchRemoteName(upstream);
  await runCommand("git", ["fetch", "--prune", remoteName], workDir, agentEnvironment);
  return getGitPanelData(sessionId, userId);
}

export async function getGitDiffData(
  sessionId: string,
  relativePath: string,
  userId?: string,
): Promise<GitDiffData> {
  const workDir = await resolveSessionWorkDir(sessionId);
  const agentEnvironment = await resolveCommandEnvironment(workDir, userId);
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

  const diff = await runOptionalCommand(
    "git",
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

async function resolveCommandEnvironment(
  workDir: string,
  userId?: string,
): Promise<AgentEnvironment> {
  if (userId) {
    return getAgentEnvironment(userId);
  }

  if (isWindowsHostedWslFilesystemPath(workDir)) return "wsl";
  if (getRuntimePlatform() === "win32" && workDir.trim().startsWith("/")) {
    return "wsl";
  }
  return "native";
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
