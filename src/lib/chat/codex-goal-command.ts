import type { SessionGoal, SessionGoalStatus, SessionGoalUpdate } from '@/types/session-goal';

export const CODEX_GOAL_COMMAND_NAME = 'goal';
export const CODEX_GOAL_COMMAND = `/${CODEX_GOAL_COMMAND_NAME}`;
export const CODEX_GOAL_BUILTIN_COMMAND = 'codex-goal';
export const CODEX_GOAL_COMMAND_DESCRIPTION = 'Set or inspect Codex goal';

export type CodexGoalCommand =
  | { kind: 'inspect' }
  | { kind: 'edit' }
  | { kind: 'clear' }
  | { kind: 'set'; update: SessionGoalUpdate };

export const CODEX_GOAL_MAX_OBJECTIVE_LENGTH = 4_000;

export function countCodexGoalObjectiveCharacters(objective: string): number {
  return Array.from(objective).length;
}

export function parseCodexGoalEditObjective(input: string): string | null {
  const trimmed = input.trim();
  if (trimmed === CODEX_GOAL_COMMAND) return '';
  if (!trimmed.startsWith(`${CODEX_GOAL_COMMAND} `)) return null;
  return trimmed.slice(CODEX_GOAL_COMMAND.length).trim();
}

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
  if (normalized === 'edit') return { kind: 'edit' };
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

export function buildCodexGoalEditUpdate(
  goal: SessionGoal,
  objective: string,
): SessionGoalUpdate {
  return {
    objective,
    tokenBudget: goal.tokenBudget,
    status: goal.status === 'budgetLimited' || goal.status === 'complete'
      ? 'active'
      : goal.status,
  };
}

export interface CodexGoalCommandLike {
  name?: string;
  builtinCommand?: string;
}

export function isCodexGoalCommandSkill(skill: CodexGoalCommandLike | null | undefined): boolean {
  return skill?.builtinCommand === CODEX_GOAL_BUILTIN_COMMAND;
}
