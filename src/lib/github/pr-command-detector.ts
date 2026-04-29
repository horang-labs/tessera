/**
 * Detect shell commands that likely change a task's PR or remote-branch
 * state so we can trigger `syncTaskPr` immediately instead of waiting for
 * turn-end / the 10-min poll.
 *
 * We match on the raw command string extracted from the tool call params —
 * Claude Code's Bash tool stores it under `command`, Codex's `exec_command`
 * under `cmd`. Both providers end up funneling the same shell string here.
 *
 * Idempotency note: the downstream `syncTaskPr` is safe to call spuriously
 * (it coalesces in-flight probes and no-ops when nothing changed), so we
 * don't need exit-code guards — firing on a failed command is cheap, and
 * the regex is specific enough that false positives are rare in practice.
 */
export function extractShellCommandFromToolParams(
  toolName: string,
  toolParams: Record<string, unknown> | undefined,
): string | null {
  if (!toolParams) return null;

  // Claude Code — Bash tool, input shape: { command: string }
  if (toolName === 'Bash') {
    const cmd = toolParams['command'];
    return typeof cmd === 'string' ? cmd : null;
  }

  // Codex — exec_command function call, arguments parsed into { cmd: string }
  if (toolName === 'exec_command' || toolName === 'exec') {
    const cmd = toolParams['cmd'] ?? toolParams['command'];
    return typeof cmd === 'string' ? cmd : null;
  }

  return null;
}

// Commands that affect PR or remote branch state. Matches are substring /
// regex on the whole command string (including any `&&`, `;`, newline
// chains), so a single `git push && gh pr merge` still yields one trigger.
const PR_IMPACTING_PATTERNS: readonly RegExp[] = [
  /\bgh\s+pr\s+(?:create|merge|close|edit|reopen)\b/,
  /\bgh\s+api\s+[^|;&\n]*\/pulls\/\d+(?:\/merge)?\b/,
  /\bgit\s+push\b/,
];

export function isPrImpactingCommand(command: string | null | undefined): boolean {
  if (!command) return false;
  return PR_IMPACTING_PATTERNS.some((rx) => rx.test(command));
}

// Commands that change anything the git panel renders: HEAD, refs, index,
// stash, working tree, remotes. Read-only inspection (status/log/diff/show)
// is intentionally excluded so the panel doesn't recompute on its own probes.
const GIT_STATE_CHANGING_PATTERNS: readonly RegExp[] = [
  /\bgit\s+(?:commit|merge|rebase|reset|revert|cherry-pick|pull|push|fetch|checkout|switch|stash|add|rm|mv|restore|tag|branch|am|apply|clean|update-ref|gc)\b/,
];

export function isGitStateChangingCommand(
  command: string | null | undefined,
): boolean {
  if (!command) return false;
  return GIT_STATE_CHANGING_PATTERNS.some((rx) => rx.test(command));
}
