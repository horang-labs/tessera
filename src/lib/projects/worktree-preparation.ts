/**
 * Runs a project's preparation scripts in a worktree, and records how it went.
 *
 * Preparation is two stages run one after the other: `before`, which an agent
 * waits for, and `after`, which it does not. Each is its own process, so the
 * moment `before` ends is a real event the agent gate can be released on —
 * rather than a point somewhere inside a script nobody outside it can see.
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
import { getProject, readProjectPreparationScript } from '@/lib/db/projects';
import {
  finishPreparationStage,
  finishTaskPreparation,
  getTaskPreparationContext,
  recordPreparationScripts,
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
import { expandPreparationVariables } from './preparation-script-preview';
import { normalizePreparationScript } from './preparation-script-policy';
import { getPreparationTerminalId } from './preparation-terminal-id';
import type { PreparationPhase } from './preparation-status-policy';

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
  /** Public Project identity when its host filesystem path differs from its ID. */
  projectId?: string;
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
  const project = getProject(request.projectId ?? request.projectDir);
  const before = normalizePreparationScript(project?.preparation_script);
  const after = normalizePreparationScript(project?.preparation_after_script);
  if (!before && !after) return { started: false, reason: 'no_script' };

  // Claimed in this function's synchronous run, ahead of its first await, so
  // that two callers racing to prepare the same worktree cannot both win — and,
  // just as importantly, so the claim is already stored by the time the caller
  // gets control back. The worktree route starts preparation without waiting
  // for it and answers immediately; the session that answer leads to can open
  // its PTY within milliseconds, and the gate holding that PTY reads this very
  // status. Awaiting anything ahead of the claim leaves that gate looking at a
  // worktree which says nothing is being prepared, and an agent then starts
  // into a worktree still missing the files it reads once, at startup.
  //
  // The scripts go down as the project wrote them and are rewritten below, once
  // there is a spec to expand them against.
  const started = startTaskPreparation(request.taskId, { before, after });
  if (!started) return { started: false, reason: 'already_running' };

  try {
    const settings = await SettingsManager.load(request.userId);
    const runGit = createGitRunner(settings.agentEnvironment);
    const runnerScriptDir = await resolveRunnerScriptDir(request.worktreePath, runGit);

    const buildSpec = (phase: PreparationPhase): PreparationExecutionSpec | null =>
      buildPreparationExecutionSpec({
        script: readProjectPreparationScript(
          { preparation_script: before, preparation_after_script: after },
          phase,
        ),
        phase,
        projectDir: request.projectDir,
        worktreePath: request.worktreePath,
        branchName: request.branchName,
        agentEnvironment: settings.agentEnvironment,
        runnerScriptDir,
        env: process.env,
      });

    // A project with nothing blocking starts at the stage it does have, so the
    // agent is never held for a run that was not going to hold it anyway.
    const firstPhase: PreparationPhase = before ? 'before' : 'after';
    const spec = buildSpec(firstPhase);
    // The claim above was made on a script that is there, so failing to build a
    // spec from it is a fault rather than a project with nothing to run.
    if (!spec) throw new Error(`Preparation has no runnable ${firstPhase} script`);

    // Now that the environment is known, the stored scripts are replaced by the
    // expanded forms — the way the shell's own trace will show them, so the log
    // and the scripts beside it describe the same run.
    recordPreparationScripts(request.taskId, {
      before: before ? expandPreparationVariables(before, spec.env) : null,
      after: after ? expandPreparationVariables(after, spec.env) : null,
    });

    await spawnPreparationStage(request, firstPhase, spec, buildSpec);
    return { started: true };
  } catch (error) {
    // The status was already claimed, so a failure anywhere after it has to be
    // released as one — otherwise the worktree stays "preparing" for the rest
    // of the session, and the gate holds every agent that enters it.
    finishTaskPreparation(
      request.taskId,
      PREPARATION_NOT_STARTED_EXIT_CODE,
      error instanceof Error ? error.message : String(error),
    );
    announcePreparationStatus(request);
    throw error;
  }
}

/**
 * Write one stage's runner, start its PTY, and hand over to the next stage when
 * it ends.
 *
 * The handover happens inside the exit observer because that is the only place
 * that knows the stage is over. The terminal id is shared between the stages:
 * the manager removes an ended runtime before the observer runs, so the second
 * stage claims the same id, and a surface watching the run keeps watching it.
 */
async function spawnPreparationStage(
  request: WorktreePreparationRequest,
  phase: PreparationPhase,
  spec: PreparationExecutionSpec,
  buildSpec: (phase: PreparationPhase) => PreparationExecutionSpec | null,
): Promise<void> {
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
          { phase, taskId: request.taskId, worktreePath: request.worktreePath },
          'Worktree preparation was cut short by shutdown; leaving it for the next startup',
        );
        return;
      }

      const result = finishPreparationStage(request.taskId, event.exitCode, output);
      // Nobody asked for this status, so nobody is polling for it either.
      if (result) announcePreparationStatus(request);
      logger.info(
        {
          exitCode: event.exitCode,
          phase,
          recorded: Boolean(result),
          status: result?.status,
          taskId: request.taskId,
          worktreePath: request.worktreePath,
        },
        result
          ? 'Worktree preparation stage finished'
          : 'Worktree preparation exited after its status had moved on',
      );

      if (!result?.nextPhase) return;
      void continuePreparation(request, result.nextPhase, buildSpec);
    },
  });

  announcePreparationStatus(request);
  logger.info(
    {
      branchName: request.branchName,
      phase,
      projectDir: request.projectDir,
      runnerScriptPath: spec.runnerScriptPath,
      taskId: request.taskId,
      worktreePath: request.worktreePath,
    },
    'Worktree preparation stage started',
  );
}

/**
 * Start the stage the one that just ended handed over to.
 *
 * A failure here ends the run rather than leaving it `running` forever: the
 * blocking stage has already succeeded by this point, so what is lost is the
 * work an agent was never waiting for — but a status that never settles would
 * keep the worktree looking busy for the rest of the session.
 */
async function continuePreparation(
  request: WorktreePreparationRequest,
  phase: PreparationPhase,
  buildSpec: (phase: PreparationPhase) => PreparationExecutionSpec | null,
): Promise<void> {
  try {
    const spec = buildSpec(phase);
    if (!spec) {
      finishTaskPreparation(request.taskId, 0, '');
      announcePreparationStatus(request);
      return;
    }
    await spawnPreparationStage(request, phase, spec, buildSpec);
  } catch (error) {
    logger.error(
      { error, phase, taskId: request.taskId, worktreePath: request.worktreePath },
      'Worktree preparation could not continue into its next stage',
    );
    finishTaskPreparation(
      request.taskId,
      PREPARATION_NOT_STARTED_EXIT_CODE,
      error instanceof Error ? error.message : String(error),
    );
    announcePreparationStatus(request);
  }
}

/** Tell the user's windows that a task's preparation status moved. */
function announcePreparationStatus(request: WorktreePreparationRequest): void {
  broadcastTaskMutation(request.userId, {
    kind: 'updated',
    projectId: request.projectId ?? request.projectDir,
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
