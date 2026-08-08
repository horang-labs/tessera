import fs from 'node:fs';
import path from 'node:path';
import { getAgentEnvironment } from '@/lib/cli/spawn-cli';
import {
  isBridgedAgentEnvironment,
  resolveAgentHomeFilesystemPath,
  resolveAgentReportedPath,
  type FilesystemBrowseEnvironment,
} from '@/lib/filesystem/path-environment';
import type {
  ProviderTerminalSessionObserver,
  ProviderTerminalSessionObserverOptions,
} from '../provider-contract';
import {
  createTerminalSessionArtifactObserver,
  type ProviderSessionArtifactCandidate,
} from '../terminal-session-artifact-observer';

/**
 * Where Claude records background `/fork` jobs, as a path *this server* can open.
 *
 * The CLI writes `<config>/jobs/<first 8 chars of session id>/state.json`, and
 * across a bridge that file lives on the agent's filesystem, not the server's:
 * a Windows server resolving `~/.claude/jobs` for a WSL agent lands in
 * `C:\Users\...\.claude\jobs`, which the CLI has never written to. Reading the
 * wrong side is silent — the job simply looks absent, and a background fork gets
 * misread as the PTY switching conversations.
 */
export async function resolveClaudeJobsDir(options: {
  environment: FilesystemBrowseEnvironment;
  /** Overrides the jobs root (tests). */
  jobsDir?: string;
}): Promise<string> {
  if (options.jobsDir) return options.jobsDir;

  // `CLAUDE_CONFIG_DIR` describes this server's environment. Across a bridge the
  // CLI runs on the other side and never saw it, so only its own home applies.
  const configuredDir = isBridgedAgentEnvironment(options.environment)
    ? null
    : process.env.CLAUDE_CONFIG_DIR?.trim();
  const configDir = configuredDir
    ? path.resolve(configuredDir)
    : path.join(await resolveAgentHomeFilesystemPath(options.environment), '.claude');
  return path.join(configDir, 'jobs');
}

function readClaudeFork(filePath: string): ProviderSessionArtifactCandidate | null {
  let state: Record<string, unknown>;
  try {
    state = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
  const providerSessionId = typeof state.forkSessionId === 'string'
    ? state.forkSessionId.trim()
    : '';
  const previousProviderSessionId = typeof state.forkParentSessionId === 'string'
    ? state.forkParentSessionId.trim()
    : '';
  if (
    !providerSessionId
    || !previousProviderSessionId
    || providerSessionId === previousProviderSessionId
    || state.interactiveLineage !== true
  ) return null;
  // Forking out of a linked worktree runs the child in the origin checkout the
  // parent branched from, so the child must not inherit the parent's work dir.
  const workDir = typeof state.cwd === 'string' ? state.cwd.trim() : '';
  return {
    activation: 'background',
    providerSessionId,
    previousProviderSessionId,
    ...(workDir ? { workDir } : {}),
  };
}

export function createClaudeTerminalSessionObserver(
  options: ProviderTerminalSessionObserverOptions & {
    jobsDir?: string;
    /** Overrides the resolved environment (tests). */
    environment?: FilesystemBrowseEnvironment;
  },
): ProviderTerminalSessionObserver {
  return createTerminalSessionArtifactObserver({
    root: (async () => resolveClaudeJobsDir({
      environment: options.environment ?? await getAgentEnvironment(options.userId),
      jobsDir: options.jobsDir,
    }))(),
    matchesPath: (relativePath) => path.basename(relativePath) === 'state.json',
    readCandidate: readClaudeFork,
    currentProviderSessionId: options.currentProviderSessionId,
    onObservation: options.onObservation,
  });
}

/**
 * Whether the identity a hook just reported belongs to a background `/fork`
 * child rather than to this PTY. Returns the child's own details when it does,
 * `null` when it does not — Claude keeps the parent conversation on the PTY, so
 * misreading this hands the terminal to a session that was never on screen.
 */
export async function resolveClaudeBackgroundTerminalSessionFork(options: {
  currentProviderSessionId: string;
  observedProviderSessionId: string;
  /** Whose CLI this is. Decides which filesystem holds the job file. */
  userId?: string;
  /** Overrides the resolved environment (tests). */
  environment?: FilesystemBrowseEnvironment;
  /** Overrides the jobs root (tests). */
  jobsDir?: string;
}): Promise<{ workDir?: string } | null> {
  const environment = options.environment ?? await getAgentEnvironment(options.userId);
  const jobsRoot = await resolveClaudeJobsDir({ environment, jobsDir: options.jobsDir });
  const jobDir = path.join(jobsRoot, options.observedProviderSessionId.slice(0, 8));
  const candidate = readClaudeFork(path.join(jobDir, 'state.json'));
  if (
    !candidate
    || candidate.activation !== 'background'
    || candidate.previousProviderSessionId !== options.currentProviderSessionId
    || candidate.providerSessionId !== options.observedProviderSessionId
  ) return null;

  // `cwd` is the CLI's own view of the path; the server may sit on the other
  // side of a bridge and has to translate before it can store or open it.
  const workDir = candidate.workDir
    ? await resolveAgentReportedPath(candidate.workDir, environment)
    : '';
  return workDir ? { workDir } : {};
}
