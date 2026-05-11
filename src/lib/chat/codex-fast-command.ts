export const CODEX_FAST_COMMAND_NAME = 'fast';
export const CODEX_FAST_COMMAND = `/${CODEX_FAST_COMMAND_NAME}`;
export const CODEX_FAST_SERVICE_TIER = 'priority';
export const CODEX_FAST_BUILTIN_COMMAND = 'codex-fast';
export const CODEX_FAST_COMMAND_DESCRIPTION = 'Toggle Codex fast mode';

export interface CodexFastCommandLike {
  name?: string;
  builtinCommand?: string;
}

export function isCodexFastCommandSkill(skill: CodexFastCommandLike | null | undefined): boolean {
  return skill?.builtinCommand === CODEX_FAST_BUILTIN_COMMAND;
}
