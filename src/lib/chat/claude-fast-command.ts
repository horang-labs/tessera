import { CODEX_FAST_COMMAND, CODEX_FAST_COMMAND_NAME } from './codex-fast-command';

// Claude Code reuses the shared `/fast` command text; the provider is disambiguated
// by the builtinCommand id so the picker/interception can route to the fastMode
// (boolean) path instead of Codex's serviceTier path.
export const CLAUDE_FAST_COMMAND_NAME = CODEX_FAST_COMMAND_NAME;
export const CLAUDE_FAST_COMMAND = CODEX_FAST_COMMAND;
export const CLAUDE_FAST_COMMAND_DESCRIPTION = 'Toggle Claude fast mode (high-speed) for this session';
export const CLAUDE_FAST_BUILTIN_COMMAND = 'claude-fast';

export interface ClaudeFastCommandLike {
  name?: string;
  builtinCommand?: string;
}

export function isClaudeFastCommandSkill(skill: ClaudeFastCommandLike | null | undefined): boolean {
  return skill?.builtinCommand === CLAUDE_FAST_BUILTIN_COMMAND;
}
