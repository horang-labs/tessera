export const CODEX_COMPACT_COMMAND_NAME = 'compact';
export const CODEX_COMPACT_COMMAND = `/${CODEX_COMPACT_COMMAND_NAME}`;
export const CODEX_COMPACT_BUILTIN_COMMAND = 'codex-compact';
export const CODEX_COMPACT_COMMAND_DESCRIPTION = 'Compact Codex context';

export interface CodexCompactCommandLike {
  name?: string;
  builtinCommand?: string;
}

export function isCodexCompactCommandSkill(skill: CodexCompactCommandLike | null | undefined): boolean {
  return skill?.builtinCommand === CODEX_COMPACT_BUILTIN_COMMAND;
}
