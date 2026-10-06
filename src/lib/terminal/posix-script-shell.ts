import * as path from 'path';

// Hands a POSIX sh script to the user's own shell without asking that shell to
// parse it.
//
// The provider probe and the PTY launch wrapper are written in POSIX sh
// (`p=$(…)`, `if [ … ]; then … fi`), and they run through the user's shell so
// that detection and launch see the PATH the user's rc files build. fish and
// nushell reject that grammar outright (fish: "Unsupported use of '='", exit
// 127), which blocked setup and every PTY launch for those users (#520).
//
// Falling back to /bin/sh is not the answer: fish users keep their PATH in
// config.fish, which /bin/sh never reads, so the agent CLIs vanish. Instead the
// user's shell gets one line that every shell reads the same way — a bare
// command with a single-quoted argument and no backslashes — and the script
// travels in an environment variable:
//
//   exec /bin/sh -c 'eval "$TESSERA_POSIX_SCRIPT"'
//
// The user's shell still starts up (config.fish runs, PATH is built), execs
// /bin/sh with that environment, and sh runs the script. Measured with fish
// 4.9.3 and nushell 0.116: PATH entries added in config.fish reach the script,
// exit codes propagate, and the exec chain leaves only the final program
// running.

/**
 * Shells that parse POSIX sh and get the script directly, exactly as before.
 * Anything else goes through the handoff, which also works in POSIX shells, so
 * a POSIX shell missing from this list costs one extra exec and nothing more.
 * Mirrors the list in `@/lib/cli/wsl-login-shell-command`.
 */
const POSIX_SHELL_NAMES = new Set(['sh', 'dash', 'bash', 'zsh', 'ksh', 'mksh', 'ash']);

export const POSIX_SCRIPT_ENV = 'TESSERA_POSIX_SCRIPT';

const POSIX_SCRIPT_HANDOFF = `exec /bin/sh -c 'eval "$${POSIX_SCRIPT_ENV}"'`;

export function isPosixShell(shell: string): boolean {
  return POSIX_SHELL_NAMES.has(path.posix.basename(shell).toLowerCase());
}

export interface PosixScriptInvocation {
  args: string[];
  /** Extra environment the shell must be spawned with, when the script travels there. */
  env?: Record<string, string>;
}

/**
 * Builds the argv that runs `script` through `shell` started with `flags`
 * (e.g. `['-l']`). Spawn `shell` with the returned args, merging `env` into
 * the child environment when present.
 */
export function buildPosixScriptInvocation(
  shell: string,
  flags: string[],
  script: string,
): PosixScriptInvocation {
  if (isPosixShell(shell)) {
    return { args: [...flags, '-c', script] };
  }
  return {
    args: [...flags, '-c', POSIX_SCRIPT_HANDOFF],
    // Unset first so the agent CLI the script execs does not inherit it.
    env: { [POSIX_SCRIPT_ENV]: `unset ${POSIX_SCRIPT_ENV}; ${script}` },
  };
}
