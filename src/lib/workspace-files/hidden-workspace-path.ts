/**
 * Dotfiles that stay visible even when "show hidden files" is off. `.env.example`
 * is a committed template meant to be read, unlike `.env` and other dotfiles.
 */
const ALWAYS_VISIBLE_DOTFILE_BASENAMES = new Set([".env.example"]);

/**
 * A workspace-relative path is "hidden" when its basename or any ancestor
 * directory starts with a dot. Mirrors the default dotfile filtering that
 * `isIgnoredWorkspacePath` applies server-side, but kept dependency-free (no
 * node builtins) so the client bundle can reuse it for the show-hidden toggle.
 *
 * Build/VCS/cache output dirs (node_modules, .git, …) are excluded earlier by
 * the server scan and never reach this check.
 */
export function isHiddenWorkspaceRelativePath(relativePath: string): boolean {
  const parts = relativePath.split(/[/\\]+/).filter((part) => part && part !== ".");
  if (parts.length === 0) return false;

  const basename = parts[parts.length - 1];
  const ancestors = parts.slice(0, -1);
  if (ancestors.some((part) => part.startsWith("."))) return true;
  return basename.startsWith(".") && !ALWAYS_VISIBLE_DOTFILE_BASENAMES.has(basename);
}
