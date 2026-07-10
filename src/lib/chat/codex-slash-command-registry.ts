/**
 * Codex TUI slash-command namespace pinned to codex-cli 0.144.1.
 *
 * Recognition and Tessera support are intentionally separate: every official
 * name is reserved before skill parsing, while only the commands with native
 * app-server implementations are dispatched by Tessera.
 */
export const CODEX_0_144_1_SLASH_COMMAND_NAMES = [
  'model',
  'ide',
  'permissions',
  'keymap',
  'vim',
  'setup-default-sandbox',
  'sandbox-add-read-dir',
  'experimental',
  'approve',
  'memories',
  'skills',
  'import',
  'hooks',
  'review',
  'rename',
  'new',
  'archive',
  'delete',
  'resume',
  'fork',
  'app',
  'init',
  'compact',
  'plan',
  'goal',
  'agent',
  'side',
  'btw',
  'copy',
  'raw',
  'diff',
  'mention',
  'status',
  'usage',
  'debug-config',
  'title',
  'statusline',
  'theme',
  'pets',
  'mcp',
  'apps',
  'plugins',
  'logout',
  'quit',
  'exit',
  'feedback',
  'rollout',
  'ps',
  'stop',
  'clear',
  'personality',
  'test-approval',
  'subagents',
  'debug-m-drop',
  'debug-m-update',
] as const;

export const CODEX_0_144_1_SLASH_COMMAND_ALIASES = {
  clean: 'stop',
  pet: 'pets',
} as const;

export type CodexNativeSlashCommand = 'fast' | 'compact' | 'goal';

export interface CodexSlashCommandMatch {
  /** Command name exactly as typed, without the leading slash. */
  name: string;
  /** Canonical Codex command name. */
  canonicalName: string;
  /** Remaining text after the command token. */
  args: string;
  support: 'native' | 'unsupported';
  nativeCommand?: CodexNativeSlashCommand;
}

const OFFICIAL_COMMAND_NAMES = new Set<string>(CODEX_0_144_1_SLASH_COMMAND_NAMES);
const OFFICIAL_COMMAND_ALIASES = new Map<string, string>(
  Object.entries(CODEX_0_144_1_SLASH_COMMAND_ALIASES),
);

function isGoalAlias(name: string): boolean {
  const repeatedOs = name.startsWith('g') && name.endsWith('al')
    ? name.slice(1, -2)
    : '';
  return repeatedOs.length > 0 && /^o+$/.test(repeatedOs);
}

export function resolveCodexSlashCommandName(name: string): string | null {
  if (!name || name !== name.toLowerCase()) return null;
  if (name === 'fast') return 'fast';
  if (isGoalAlias(name)) return 'goal';
  return OFFICIAL_COMMAND_ALIASES.get(name)
    ?? (OFFICIAL_COMMAND_NAMES.has(name) ? name : null);
}

export function isReservedCodexSlashCommandName(name: string): boolean {
  return resolveCodexSlashCommandName(name) !== null;
}

export function classifyCodexSlashCommand(input: string): CodexSlashCommandMatch | null {
  const trimmedStart = input.trimStart();
  if (!trimmedStart.startsWith('/')) return null;

  const tokenEnd = trimmedStart.search(/\s/);
  const token = tokenEnd === -1 ? trimmedStart : trimmedStart.slice(0, tokenEnd);
  const name = token.slice(1);
  const canonicalName = resolveCodexSlashCommandName(name);
  if (!canonicalName) return null;

  const args = tokenEnd === -1 ? '' : trimmedStart.slice(tokenEnd).trim();
  if (canonicalName === 'fast' || canonicalName === 'compact' || canonicalName === 'goal') {
    return {
      name,
      canonicalName,
      args,
      support: 'native',
      nativeCommand: canonicalName,
    };
  }

  return {
    name,
    canonicalName,
    args,
    support: 'unsupported',
  };
}
