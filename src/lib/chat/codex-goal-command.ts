import type { SessionGoalStatus, SessionGoalUpdate } from '@/types/session-goal';

export const CODEX_GOAL_COMMAND_NAME = 'goal';
export const CODEX_GOAL_COMMAND = `/${CODEX_GOAL_COMMAND_NAME}`;
export const CODEX_GOAL_BUILTIN_COMMAND = 'codex-goal';
export const CODEX_GOAL_COMMAND_DESCRIPTION = 'Set or inspect Codex goal';

export type CodexGoalCommand =
  | { kind: 'inspect' }
  | { kind: 'clear' }
  | { kind: 'set'; update: SessionGoalUpdate };

function statusUpdate(status: SessionGoalStatus): CodexGoalCommand {
  return {
    kind: 'set',
    update: { status },
  };
}

export function parseCodexGoalCommand(input: string): CodexGoalCommand | null {
  const trimmed = input.trim();
  if (trimmed !== CODEX_GOAL_COMMAND && !trimmed.startsWith(`${CODEX_GOAL_COMMAND} `)) {
    return null;
  }

  const body = trimmed.slice(CODEX_GOAL_COMMAND.length).trim();
  if (!body) {
    return { kind: 'inspect' };
  }

  const normalized = body.toLowerCase();
  if (normalized === 'clear') return { kind: 'clear' };
  if (normalized === 'pause') return statusUpdate('paused');
  if (normalized === 'resume') return statusUpdate('active');

  return {
    kind: 'set',
    update: {
      objective: body,
      status: 'active',
    },
  };
}

export interface CodexGoalCommandLike {
  name?: string;
  builtinCommand?: string;
}

export function isCodexGoalCommandSkill(skill: CodexGoalCommandLike | null | undefined): boolean {
  return skill?.builtinCommand === CODEX_GOAL_BUILTIN_COMMAND;
}
