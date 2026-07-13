/**
 * Codex TUI slash-command namespace pinned to codex-cli 0.144.1.
 *
 * Recognition and execution are intentionally separate. Official names are
 * reserved before skill/prompt handling, then routed to a Tessera control, a
 * Codex terminal escape hatch, or an explicit hidden/unsupported result.
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

export type CodexCanonicalSlashCommand = typeof CODEX_0_144_1_SLASH_COMMAND_NAMES[number];

export const CODEX_0_144_1_SLASH_COMMAND_ALIASES = {
  clean: 'stop',
  pet: 'pets',
} as const;

export type CodexSlashCommandSupport =
  | 'native'
  | 'terminal-direct'
  | 'terminal-handoff'
  | 'hidden';

export type CodexNativeSlashCommand =
  | 'fast'
  | 'compact'
  | 'goal'
  | 'model'
  | 'permissions'
  | 'skills'
  | 'rename'
  | 'new'
  | 'archive'
  | 'delete'
  | 'fork'
  | 'plan'
  | 'copy'
  | 'diff'
  | 'mention'
  | 'status'
  | 'clear';

export type CodexTerminalMode = 'tui' | 'resume-picker';

export interface CodexSlashCommandMatch {
  /** Command name exactly as typed, without the leading slash. */
  name: string;
  /** Canonical Codex command name. */
  canonicalName: string;
  /** Remaining text after the command token. */
  args: string;
  support: CodexSlashCommandSupport;
  nativeCommand?: CodexNativeSlashCommand;
  terminalMode?: CodexTerminalMode;
}

export interface CodexSlashCommandAvailability {
  platform?: string | null;
  agentEnvironment?: string | null;
}

export interface CodexSlashCommandPickerItem {
  name: CodexCanonicalSlashCommand;
  description: string;
  support: Exclude<CodexSlashCommandSupport, 'hidden'>;
}

const NATIVE_COMMANDS = new Set<CodexCanonicalSlashCommand>([
  'model', 'permissions', 'skills', 'rename', 'new', 'archive', 'delete', 'fork',
  'compact', 'plan', 'goal', 'copy', 'diff', 'mention', 'status', 'clear',
]);

const TERMINAL_DIRECT_COMMANDS = new Set<CodexCanonicalSlashCommand>([
  'setup-default-sandbox', 'sandbox-add-read-dir', 'experimental', 'import',
  'hooks', 'resume', 'init', 'usage', 'debug-config', 'mcp', 'apps', 'plugins',
  'logout',
]);

const TERMINAL_HANDOFF_COMMANDS = new Set<CodexCanonicalSlashCommand>([
  'memories', 'review', 'agent', 'side', 'btw', 'feedback', 'personality',
  'subagents',
]);

const HIDDEN_COMMANDS = new Set<CodexCanonicalSlashCommand>([
  'ide', 'keymap', 'vim', 'approve', 'app', 'raw', 'title', 'statusline',
  'theme', 'pets', 'quit', 'exit', 'rollout', 'ps', 'stop', 'test-approval',
  'debug-m-drop', 'debug-m-update',
]);

const WINDOWS_NATIVE_ONLY_COMMANDS = new Set<CodexCanonicalSlashCommand>([
  'setup-default-sandbox', 'sandbox-add-read-dir',
]);

const COMMAND_DESCRIPTIONS: Partial<Record<CodexCanonicalSlashCommand, string>> = {
  model: 'Choose the model used by this Tessera session',
  permissions: 'Open Tessera access controls',
  skills: 'Browse skills available to this Codex session',
  rename: 'Rename this Tessera session',
  new: 'Start a new Tessera session in this project',
  archive: 'Archive this Tessera session',
  delete: 'Delete this Tessera session and its Codex thread',
  fork: 'Fork this Codex thread into a new Tessera session',
  plan: 'Switch this Tessera session to plan mode',
  copy: 'Copy the latest assistant response',
  diff: 'Open the Tessera Git diff panel',
  mention: 'Open the workspace reference picker',
  status: 'Show the current Tessera session status',
  clear: 'Start a new session without deleting this history',
  resume: 'Continue a saved task in a Codex terminal',
  usage: 'Show Codex account usage in a terminal',
  review: 'Hand this thread off to Codex review in a terminal',
  personality: 'Choose a Codex personality in a terminal',
};

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

function commandSupport(command: CodexCanonicalSlashCommand): CodexSlashCommandSupport {
  if (NATIVE_COMMANDS.has(command)) return 'native';
  if (TERMINAL_DIRECT_COMMANDS.has(command)) return 'terminal-direct';
  if (TERMINAL_HANDOFF_COMMANDS.has(command)) return 'terminal-handoff';
  return 'hidden';
}

function terminalMode(command: CodexCanonicalSlashCommand): CodexTerminalMode | undefined {
  if (command === 'resume') return 'resume-picker';
  if (commandSupport(command).startsWith('terminal-')) return 'tui';
  return undefined;
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

export function isCodexSlashCommandAvailable(
  canonicalName: string,
  availability: CodexSlashCommandAvailability = {},
): boolean {
  if (!WINDOWS_NATIVE_ONLY_COMMANDS.has(canonicalName as CodexCanonicalSlashCommand)) {
    return true;
  }
  return availability.platform === 'win32' && availability.agentEnvironment === 'native';
}

export function getCodexSlashCommandsForPicker(
  availability: CodexSlashCommandAvailability = {},
): CodexSlashCommandPickerItem[] {
  return CODEX_0_144_1_SLASH_COMMAND_NAMES.flatMap((name) => {
    const support = commandSupport(name);
    if (support === 'hidden' || name === 'compact' || name === 'goal') return [];
    if (!isCodexSlashCommandAvailable(name, availability)) return [];
    return [{
      name,
      description: COMMAND_DESCRIPTIONS[name] ?? `Run /${name} in ${support === 'native' ? 'Tessera' : 'a Codex terminal'}`,
      support,
    }];
  });
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
  if (canonicalName === 'fast') {
    return { name, canonicalName, args, support: 'native', nativeCommand: 'fast' };
  }

  const canonicalCommand = canonicalName as CodexCanonicalSlashCommand;
  const support = commandSupport(canonicalCommand);
  return {
    name,
    canonicalName,
    args,
    support,
    ...(support === 'native' ? { nativeCommand: canonicalCommand as CodexNativeSlashCommand } : {}),
    ...(support.startsWith('terminal-') ? { terminalMode: terminalMode(canonicalCommand) } : {}),
  };
}

export const CODEX_0_144_1_ROUTE_COUNTS = {
  native: NATIVE_COMMANDS.size,
  terminalDirect: TERMINAL_DIRECT_COMMANDS.size,
  terminalHandoff: TERMINAL_HANDOFF_COMMANDS.size,
  hidden: HIDDEN_COMMANDS.size,
} as const;
