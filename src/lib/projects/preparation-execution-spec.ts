/**
 * Turns a project's preparation script into a runner script and the command
 * that runs it in a new worktree. Pure: the caller writes the runner, spawns
 * the command, and owns every other side effect.
 *
 * The script becomes a file rather than an argument because a command line has
 * to survive being quoted for a shell, and a preparation script is full of the
 * quotes and paths that breaks. A file is handed over by name.
 */

import {
  formatPathForAgentDisplay,
  resolveWslDisplayPathAgainstWindowsHostedPath,
} from '@/lib/filesystem/path-environment';
import {
  getFilesystemPathModule,
  isWindowsStyleFilesystemPath,
} from '@/lib/filesystem/host-path';
import {
  WSL_LOGIN_SHELL_DISCOVERY,
  quoteBashArg,
  resolvePosixTerminalShellCommand,
} from '@/lib/terminal/terminal-resolver';
import { getRuntimePlatform } from '@/lib/system/runtime-platform';
import type { AgentEnvironment } from '@/lib/settings/types';
import {
  PREPARATION_PROJECT_DIR_ENV,
  PREPARATION_WORKTREE_DIR_ENV,
  PREPARATION_BRANCH_NAME_ENV,
} from './preparation-environment';
import { normalizePreparationScript } from './preparation-script-policy';
import type { PreparationPhase } from './preparation-status-policy';

/**
 * Each stage writes its own runner. They never run at once, so one name would
 * work — but a runner left on disk is read when something went wrong, and one
 * that cannot say which stage wrote it answers the wrong question.
 */
const RUNNER_NAMES: Record<PreparationPhase, { posix: string; windows: string }> = {
  before: { posix: 'preparation-runner.sh', windows: 'preparation-runner.cmd' },
  after: { posix: 'preparation-after-runner.sh', windows: 'preparation-after-runner.cmd' },
};
/**
 * Stops a batch run once a command reports a non-zero exit code. The leading
 * `@` keeps the guard itself out of the echo, so what the log shows is the
 * script the user wrote and not the machinery around it.
 */
const WINDOWS_FAIL_FAST_GUARD = '@if errorlevel 1 exit /b %errorlevel%';
/**
 * What `set -x` puts in front of each traced line. Dim, because the trace is
 * there to be scanned past until something goes wrong.
 */
const POSIX_TRACE_PROMPT = "$'\\033[2m+ \\033[0m'";

export interface PreparationExecutionContext {
  /** The project's stored preparation script; blank means nothing to run. */
  script: string | null | undefined;
  /** Which stage this script belongs to. Defaults to the blocking one. */
  phase?: PreparationPhase;
  /** The original checkout, as Tessera stores it. */
  projectDir: string;
  /** The newly created worktree, as Tessera stores it. */
  worktreePath: string;
  branchName: string;
  agentEnvironment: AgentEnvironment;
  /**
   * Where the runner script is written. A linked worktree's own git directory
   * is the natural home: the script stays out of the working tree, so it never
   * shows up as an untracked file the user has to explain.
   *
   * Whichever path style it arrives in is respelled for the environment that
   * runs it — git answers through the same bridge the CLI uses, so a POSIX
   * worktree can easily come back named as a Windows UNC share.
   */
  runnerScriptDir: string;
  /** The environment the PTY inherits; the POSIX shell and WSLENV come from it. */
  env?: NodeJS.ProcessEnv;
}

export interface PreparationExecutionSpec {
  program: string;
  args: string[];
  env: Record<string, string>;
  /** Where the script runs, spelled the way the environment running it spells paths. */
  cwd: string;
  /**
   * True when `program` bridges from a Windows host into WSL. `cwd` is then a
   * guest path the wrapper enters, not somewhere the host can spawn from, so
   * the caller has to choose a host directory of its own.
   */
  bridgedThroughWsl: boolean;
  /** Where the caller must write `runnerScript` before spawning. */
  runnerScriptPath: string;
  /** The runner `program` executes. Needs the execute bit on POSIX. */
  runnerScript: string;
}

/**
 * Build the runner and the command that runs it in the new worktree, or null
 * when the project has no preparation script and preparation should not happen
 * at all.
 */
export function buildPreparationExecutionSpec(
  context: PreparationExecutionContext,
): PreparationExecutionSpec | null {
  const script = normalizePreparationScript(context.script);
  if (!script) return null;

  const platform = getRuntimePlatform();
  const hostEnv = context.env ?? process.env;
  const bridgedThroughWsl = context.agentEnvironment === 'wsl' && platform === 'win32';
  const runnerNames = RUNNER_NAMES[context.phase ?? 'before'];

  if (bridgedThroughWsl) {
    const env = buildEnv(context, (value) => formatPathForAgentDisplay(value, 'wsl'));
    const runnerScriptPath = joinRunnerPath(
      formatPathForAgentDisplay(context.runnerScriptDir, 'wsl'),
      runnerNames.posix,
    );
    return {
      program: 'wsl.exe',
      args: ['-e', 'sh', '-c', buildWslBridgeScript(runnerScriptPath)],
      env: { ...env, WSLENV: buildWslenv(hostEnv.WSLENV, Object.keys(env)) },
      cwd: env[PREPARATION_WORKTREE_DIR_ENV],
      bridgedThroughWsl: true,
      runnerScriptPath,
      runnerScript: buildPosixRunnerScript(script),
    };
  }

  const env = buildEnv(context, (value) => value);

  if (platform === 'win32') {
    const runnerScriptPath = joinRunnerPath(
      toWindowsStylePath(context.runnerScriptDir, context.worktreePath),
      runnerNames.windows,
    );
    return {
      // `/d` skips any AutoRun command the user's registry would otherwise run
      // before the runner.
      program: 'cmd.exe',
      args: ['/d', '/c', runnerScriptPath],
      env,
      cwd: context.worktreePath,
      bridgedThroughWsl: false,
      runnerScriptPath,
      runnerScript: buildWindowsRunnerScript(script),
    };
  }

  const runnerScriptPath = joinRunnerPath(
    toPosixStylePath(context.runnerScriptDir),
    runnerNames.posix,
  );
  // Shared with the terminal so preparation runs under the same shell the
  // user's agents are detected and launched with.
  const { command, loginArgs } = resolvePosixTerminalShellCommand(hostEnv, platform);
  return {
    program: command,
    args: [...loginArgs, '-c', `exec bash ${quoteBashArg(runnerScriptPath)}`],
    env,
    cwd: context.worktreePath,
    bridgedThroughWsl: false,
    runnerScriptPath,
    runnerScript: buildPosixRunnerScript(script),
  };
}

function joinRunnerPath(directory: string, name: string): string {
  return getFilesystemPathModule(directory).join(directory, name);
}

/** Respell a path a Windows-side tool answered with for the shell that will run it. */
function toPosixStylePath(filesystemPath: string): string {
  return isWindowsStyleFilesystemPath(filesystemPath)
    ? formatPathForAgentDisplay(filesystemPath, 'wsl')
    : filesystemPath;
}

/** The mirror of the above, for a host whose own paths are Windows paths. */
function toWindowsStylePath(filesystemPath: string, reference: string): string {
  if (isWindowsStyleFilesystemPath(filesystemPath)) return filesystemPath;
  return resolveWslDisplayPathAgainstWindowsHostedPath(filesystemPath, reference)
    ?? filesystemPath;
}

function buildEnv(
  context: PreparationExecutionContext,
  formatPath: (value: string) => string,
): Record<string, string> {
  return {
    [PREPARATION_PROJECT_DIR_ENV]: formatPath(context.projectDir),
    [PREPARATION_WORKTREE_DIR_ENV]: formatPath(context.worktreePath),
    [PREPARATION_BRANCH_NAME_ENV]: context.branchName,
  };
}

/**
 * `set -e` leads, so a failing line aborts the run before the next one starts.
 * The worktree is entered through its environment value rather than an inlined
 * path, which keeps the runner free of quoting the user could trip over.
 *
 * `set -x` then makes the run readable: without it the log holds output with
 * nothing to attribute it to, and a failure names no line. It is switched on
 * after the `cd` so the trace shows the user's script rather than Tessera's
 * scaffolding, and the traced lines are dimmed to set them apart from the
 * output they produce.
 */
function buildPosixRunnerScript(script: string): string {
  return '#!/usr/bin/env bash\nset -e\n'
    + `cd -- "$${PREPARATION_WORKTREE_DIR_ENV}"\n`
    + `PS4=${POSIX_TRACE_PROMPT}\nset -x\n`
    + `${script}\n`;
}

/**
 * Batch has no `set -e`, so every line carries its own guard. `call` is what
 * makes the guard reachable: preparation scripts routinely invoke npm or pnpm,
 * which are batch files themselves, and one batch file calling another without
 * `call` never returns to the lines below it.
 *
 * A `#` line is dropped rather than translated to `rem`, whose argument batch
 * still parses for redirection and pipes — a comment holding `>` or `|` would
 * turn back into a command.
 *
 * Echo is switched on once the runner's own setup is done, which is batch's
 * answer to `set -x`: each command appears in the log before it runs, so the
 * output below it has something to belong to.
 */
function buildWindowsRunnerScript(script: string): string {
  let runner = '@echo off\r\nsetlocal EnableExtensions\r\n';
  runner += `cd /d "%${PREPARATION_WORKTREE_DIR_ENV}%"\r\n`;
  runner += '@echo on\r\n';

  for (const line of script.split('\n')) {
    const command = line.trim();
    runner += command && !isPosixComment(command)
      ? `call ${command}\r\n${WINDOWS_FAIL_FAST_GUARD}\r\n`
      : '\r\n';
  }

  return runner;
}

/**
 * Whether a line is a comment.
 *
 * Batch has no `#` syntax of its own, so nothing that used to run stops
 * running; what it gains is a comment marker that means the same thing here as
 * it does in the POSIX runner. That sameness is the point — the block markers
 * the checklist writes have to survive a script moving between machines.
 */
function isPosixComment(command: string): boolean {
  return command.startsWith('#');
}

/** Hand the runner to the login shell the terminal would have found. */
function buildWslBridgeScript(runnerScriptPath: string): string {
  // Login and interactive both: `-l` alone skips ~/.bashrc and ~/.zshrc, where
  // nvm, volta and friends put themselves, and the runner's tools go missing.
  const inner = `exec bash ${quoteBashArg(runnerScriptPath)}`;
  return [
    ...WSL_LOGIN_SHELL_DISCOVERY,
    `exec "$shell" -l -i -c ${quoteBashArg(inner)}`,
  ].join('; ');
}

/**
 * Name the variables that cross into the distro, keeping any the host already
 * forwards. The values are already guest paths, so they cross verbatim — a `/p`
 * flag here would translate them a second time and break them.
 */
function buildWslenv(existing: string | undefined, names: string[]): string {
  const forwarded = new Map(
    (existing ?? '').split(':').filter(Boolean).map((entry) => [entry.split('/')[0], entry]),
  );
  for (const name of names) forwarded.set(name, name);
  return [...forwarded.values()].join(':');
}
