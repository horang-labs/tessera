/**
 * Runs a project's preparation script in a worktree, and records how it went.
 *
 * Every decision lives in preparation-execution-spec and
 * preparation-status-policy; this module only reads the project, writes the
 * runner they produced, starts the PTY, and stores the outcome against the task
 * that owns the worktree.
 */

import fs from 'fs/promises';
import os from 'os';
import {
  getFilesystemPathModule,
  resolvePathForHostFilesystem,
} from '@/lib/filesystem/host-path';
import { getProject } from '@/lib/db/projects';
import {
  finishTaskPreparation,
  getTaskPreparationContext,
  startTaskPreparation,
} from '@/lib/db/task-preparation';
import logger from '@/lib/logger';
import { isServerShuttingDown } from '@/lib/server-lifecycle';
import { SettingsManager } from '@/lib/settings/manager';
import { terminalManager } from '@/lib/terminal/shared-terminal-manager';
import { broadcastTaskMutation } from '@/lib/ws/mutation-broadcast';
import { createGitRunner, type GitRunner } from '@/lib/worktrees/git-runner';
import {
  buildPreparationExecutionSpec,
  type PreparationExecutionSpec,
} from './preparation-execution-spec';
import { getPreparationTerminalId } from './preparation-terminal-id';

/** Directory under the worktree's own git storage that holds Tessera's runners. */
const RUNNER_DIR_GIT_PATH = 'tessera';

/**
 * Stands in for an exit code when preparation never reached the point of
 * having one — the runner could not be written, or the PTY refused to start.
 */
const PREPARATION_NOT_STARTED_EXIT_CODE = -1;

export interface WorktreePreparationRequest {
  userId: string;
  /** The task that owns the worktree, and therefore its preparation status. */
  taskId: string;
  /** The original checkout, which is also the project's id. */
  projectDir: string;
  worktreePath: string;
  branchName: string;
}

export type WorktreePreparationOutcome =
  | { started: true }
  | { started: false; reason: 'no_script' | 'already_running' | 'unknown_worktree' };

/**
 * Start preparation for a worktree, whether it was just created or is being
 * prepared again after a failure.
 *
 * Returns without starting anything when the project has no preparation script
 * — the case where a worktree behaves exactly as it did before this existed —
 * or when a run is already in flight.
 */
export async function startWorktreePreparation(
  request: WorktreePreparationRequest,
): Promise<WorktreePreparationOutcome> {
  const project = getProject(request.projectDir);
  if (!project?.preparation_script) return { started: false, reason: 'no_script' };

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
  // Everything above only reads, so deciding there is nothing to run costs the
  // status nothing.
  if (!spec) return { started: false, reason: 'no_script' };

  // Claimed before anything is spawned, so two callers racing to prepare the
  // same worktree cannot both win.
  if (!startTaskPreparation(request.taskId)) {
    return { started: false, reason: 'already_running' };
  }

  try {
    await writeRunnerScript(spec);

    await terminalManager.startDetached({
      terminalId: getPreparationTerminalId(request.taskId),
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
      onRuntimeExit: (event, output) => {
        // Shutdown kills this PTY, and that death arrives here looking like a
        // clean exit. Leaving the status alone keeps it at `running`, which is
        // what the next startup reads as a run the app cut short.
        if (isServerShuttingDown()) {
          logger.info(
            { taskId: request.taskId, worktreePath: request.worktreePath },
            'Worktree preparation was cut short by shutdown; leaving it for the next startup',
          );
          return;
        }

        const recorded = finishTaskPreparation(request.taskId, event.exitCode, output);
        // Nobody asked for this status, so nobody is polling for it either.
        if (recorded) announcePreparationStatus(request);
        logger.info(
          {
            exitCode: event.exitCode,
            recorded,
            taskId: request.taskId,
            worktreePath: request.worktreePath,
          },
          recorded
            ? 'Worktree preparation finished'
            : 'Worktree preparation exited after its status had moved on',
        );
      },
    });

    announcePreparationStatus(request);
    logger.info(
      {
        branchName: request.branchName,
        projectDir: request.projectDir,
        runnerScriptPath: spec.runnerScriptPath,
        taskId: request.taskId,
        worktreePath: request.worktreePath,
      },
      'Worktree preparation started',
    );
    return { started: true };
  } catch (error) {
    // The status was already claimed, so a failure here has to be released as
    // one — otherwise the worktree stays "preparing" for the rest of the session.
    finishTaskPreparation(
      request.taskId,
      PREPARATION_NOT_STARTED_EXIT_CODE,
      error instanceof Error ? error.message : String(error),
    );
    announcePreparationStatus(request);
    throw error;
  }
}

/** Tell the user's windows that a task's preparation status moved. */
function announcePreparationStatus(request: WorktreePreparationRequest): void {
  broadcastTaskMutation(request.userId, {
    kind: 'updated',
    projectId: request.projectDir,
  });
}

/**
 * Run preparation again for a worktree that already exists, after its script
 * was fixed. Everything the run needs is read back from the task.
 */
export async function rerunWorktreePreparation(
  userId: string,
  taskId: string,
): Promise<WorktreePreparationOutcome> {
  const context = getTaskPreparationContext(taskId);
  if (!context?.worktreePath || !context.branchName) {
    return { started: false, reason: 'unknown_worktree' };
  }

  return startWorktreePreparation({
    userId,
    taskId,
    projectDir: context.projectDir,
    worktreePath: context.worktreePath,
    branchName: context.branchName,
  });
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
