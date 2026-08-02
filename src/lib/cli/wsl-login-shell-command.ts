// Runs a WSL command through the distro user's own login shell.
//
// The shell is resolved *inside* WSL rather than by a separate probe on the
// Windows side. A probe has to survive the user's rc files to report its answer
// back, so one broken line in ~/.profile (sourcing a removed ~/.cargo/env, say)
// kills it — and a probe that fails leaves the caller guessing. Guessing wrong
// is not a cosmetic problem: bash and zsh build different PATHs, so the same
// `claude` resolves to a different binary than the one the user gets in their
// own terminal. Resolving in-shell removes the failure mode entirely: the
// script that picks the shell is the script that execs into it.

export function quotePosixShell(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export function escapeWslShCommandForWindows(command: string): string {
  // WSL preprocesses unescaped $ in Windows argv before the WSL-side shell
  // sees it, even when the POSIX script text would single-quote the dollar.
  let escaped = '';
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (char === '$' && command[index - 1] !== '\\') {
      escaped += '\\$';
      continue;
    }
    escaped += char;
  }
  return escaped;
}

/**
 * Wraps `command` in a POSIX-sh script that resolves the distro user's login
 * shell and execs the command through it. Pass the result to
 * `wsl sh -c <escaped>` (via escapeWslShCommandForWindows).
 *
 * Shell resolution order: the passwd entry, then $SHELL, then /bin/sh.
 *
 * Every shell gets `-ilc`, never `-lc`. Two independent reasons:
 *
 * - `-i` is what sources the *interactive* rc (~/.zshrc, ~/.bashrc), which is
 *   where nvm/asdf/homebrew put themselves. Without it the CLI resolves against
 *   a different PATH than the user's own terminal.
 * - `-i` is also the only thing that survives a broken rc. `.` (source) is a
 *   POSIX special builtin: a non-interactive shell that sources a missing file
 *   dies on the spot before it ever reaches our command. Measured on Ubuntu
 *   with a ~/.profile that sources a deleted file: `sh -lc` and `dash -lc` exit
 *   2 without running anything, while `-ilc` runs the command. bash and zsh
 *   survive either way. Users do end up with broken rc lines (a removed
 *   ~/.cargo/env is the classic), and "the app won't start" is a far worse
 *   outcome than the job-control warning `-i` prints to stderr on a non-tty.
 */
export function buildWslLoginShellCommand(command: string): string {
  // Startup files print banners on *stdout* — the MOTD, oh-my-zsh update
  // notices, nvm warnings — and Tessera parses that stdout as stream-json, so
  // a banner corrupts the very first message. Stash the real stdin/stdout on
  // fd 3/4, point the shell's own at /dev/null so startup noise is discarded,
  // then hand the originals back to the command itself. Measured on a stock
  // Ubuntu WSL image: both `bash -ilc` and `sh -ilc` dump the whole MOTD (plus
  // the sudo notice, for bash) onto stdout before running anything. It is
  // intermittent — the MOTD is once-a-day — which is exactly what makes it a
  // miserable bug to chase. stderr is deliberately left connected: it goes to
  // the debug log, and rc errors are worth seeing there.
  const quotedCommand = quotePosixShell(`exec <&3 >&4 3<&- 4>&-; ${command}`);
  return [
    'exec 3<&0',
    'exec 4>&1',
    'exec </dev/null',
    'exec >/dev/null',
    '_tessera_wsl_shell=$(getent passwd "$(id -un)" 2>/dev/null | cut -d: -f7)',
    'if [ -z "$_tessera_wsl_shell" ] || [ ! -x "$_tessera_wsl_shell" ]; then',
    '  _tessera_wsl_shell="${SHELL:-/bin/bash}"',
    'fi',
    'if [ -z "$_tessera_wsl_shell" ] || [ ! -x "$_tessera_wsl_shell" ]; then',
    '  _tessera_wsl_shell=/bin/sh',
    'fi',
    '_tessera_wsl_shell_name=$(basename "$_tessera_wsl_shell" | tr "[:upper:]" "[:lower:]")',
    'case "$_tessera_wsl_shell_name" in',
    // The command text is POSIX sh. Shells that don't speak it (fish, nushell)
    // fall through to /bin/sh rather than being handed a script they'd mangle.
    `  sh|dash|bash|zsh|ksh|mksh|ash) exec "$_tessera_wsl_shell" -ilc ${quotedCommand} ;;`,
    `  *) exec /bin/sh -ilc ${quotedCommand} ;;`,
    'esac',
  ].join('\n');
}
