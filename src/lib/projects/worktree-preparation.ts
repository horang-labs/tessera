/**
 * Runs a project's preparation script in a worktree that was just created.
 *
 * Every decision lives in preparation-execution-spec; this module only reads
 * the project, writes the runner it produced, starts the PTY, and reports
 * whether anything ran.
 */

import fs from 'fs/promises';
import os from 'os';
import {
  getFilesystemPathModule,
  resolvePathForHostFilesystem,
} from '@/lib/filesystem/host-path';
import { getProject } from '@/lib/db/projects';
import logger from '@/lib/logger';
import { SettingsManager } from '@/lib/settings/manager';
import { terminalManager } from '@/lib/terminal/shared-terminal-manager';
import { createGitRunner, type GitRunner } from '@/lib/worktrees/git-runner';
import {
  buildPreparationExecutionSpec,
  type PreparationExecutionSpec,
} from './preparation-execution-spec';

/** Directory under the worktree's own git storage that holds Tessera's runners. */
const RUNNER_DIR_GIT_PATH = 'tessera';

export interface WorktreePreparationRequest {
  userId: string;
  /** The original checkout, which is also the project's id. */
  projectDir: string;
  worktreePath: string;
  branchName: string;
}

/** Terminal id for a worktree's preparation, stable enough to find it again. */
export function getPreparationTerminalId(worktreePath: string): string {
  return `preparation:${worktreePath}`;
}

/**
 * Start preparation for a newly created worktree.
 *
 * Returns false when the project has no preparation script, which is the case
 * where a worktree is created exactly as it was before this existed.
 */
export async function startWorktreePreparation(
  request: WorktreePreparationRequest,
): Promise<boolean> {
  const project = getProject(request.projectDir);
  if (!project?.preparation_script) return false;

  const settings = await SettingsManager.load(request.userId);
  const runGit = createGitRunner(settings.agentEnvironment);
  const spec = buildPreparationExecutionSpec({
    script: project.preparation_script,
    projectDir: request.projectDir,
    worktreePath: request.worktreePath,
    branchName: request.branchName,
    agentEnvironment: settings.agentEnvironment,
    runnerScriptDir: await resolveRunnerScriptDir(request.worktreePath, runGit),
    env: process.env,
  });
  if (!spec) return false;

  await writeRunnerScript(spec);

  await terminalManager.startDetached({
    terminalId: getPreparationTerminalId(request.worktreePath),
    userId: request.userId,
    // The bridge enters the worktree from inside the distro, so the host has to
    // spawn wsl.exe from somewhere it can actually reach.
    resolvedShell: {
      command: spec.program,
      args: spec.args,
      cwd: spec.bridgedThroughWsl ? os.homedir() : spec.cwd,
      displayCwd: spec.cwd,
    },
    launchEnv: spec.env,
  });

  logger.info(
    {
      branchName: request.branchName,
      projectDir: request.projectDir,
      runnerScriptPath: spec.runnerScriptPath,
      worktreePath: request.worktreePath,
    },
    'Worktree preparation started',
  );
  return true;
}

/**
 * A linked worktree's `.git` is a file pointing at the real storage, so the
 * runner cannot simply be written under `<worktree>/.git`. Git itself resolves
 * where that storage actually is.
 */
async function resolveRunnerScriptDir(
  worktreePath: string,
  runGit: GitRunner,
): Promise<string> {
  const { stdout } = await runGit(['-C', worktreePath, 'rev-parse', '--git-path', RUNNER_DIR_GIT_PATH]);
  const resolved = stdout.trim();
  if (!resolved) {
    throw new Error(`Could not resolve the git storage path for ${worktreePath}`);
  }

  // Asked from inside the worktree, git answers with an absolute path; a
  // relative one would only be relative to the worktree itself.
  return getFilesystemPathModule(resolved).isAbsolute(resolved)
    ? resolved
    : getFilesystemPathModule(worktreePath).join(worktreePath, resolved);
}

async function writeRunnerScript(spec: PreparationExecutionSpec): Promise<void> {
  const hostPath = await resolvePathForHostFilesystem(spec.runnerScriptPath);
  const hostDir = getFilesystemPathModule(hostPath).dirname(hostPath);
  await fs.mkdir(hostDir, { recursive: true });
  // The POSIX runner is executed by name, so it needs the execute bit; on
  // Windows the mode is ignored and the extension decides.
  await fs.writeFile(hostPath, spec.runnerScript, { encoding: 'utf8', mode: 0o755 });
  await fs.chmod(hostPath, 0o755).catch(() => {
    // Windows and some mounted filesystems have no mode to set.
  });
}
