/**
 * Build the `sh -c` body of a probe that asks WSL for a path and prints it in
 * the form **this server** can open.
 *
 * Config-home probes ask the agent's side of the bridge where its CLI keeps
 * `CLAUDE.md` / `AGENTS.md`, then hand the answer straight to `fs.stat`. On a
 * Windows host the raw WSL answer is unopenable — `/home/u/.codex/AGENTS.md`
 * has no meaning to Windows — so every file reads as missing and the Context
 * panel reports "No user instructions" for a home that is fully populated.
 *
 * `wslpath -w` rewrites it to `\\wsl.localhost\<distro>\home\u\.codex`, which
 * the host can stat. It sits on WSL's default PATH and needs no rc file, so the
 * probe works with or without a login shell. The `||` keeps the untranslated
 * path as a last resort: a missing `wslpath` should degrade to today's
 * behaviour, not to an empty answer.
 *
 * @param shellPathExpression a shell expression producing the path, spliced
 *   inside double quotes — e.g. `$HOME/.claude` or `${CODEX_HOME:-$HOME/.codex}`.
 */
export function buildWslFilesystemPathProbe(shellPathExpression: string): string {
  return `p="${shellPathExpression}"; wslpath -w "$p" 2>/dev/null || printf %s "$p"`;
}
