export type SessionGoalStatus =
  | 'active'
  | 'paused'
  | 'blocked'
  | 'usageLimited'
  | 'budgetLimited'
  | 'complete';

export interface SessionGoal {
  threadId: string;
  objective: string;
  status: SessionGoalStatus;
  tokenBudget: number | null;
  tokensUsed: number;
  timeUsedSeconds: number;
  createdAt: number;
  updatedAt: number;
}

export interface SessionGoalUpdate {
  objective?: string | null;
  status?: SessionGoalStatus | null;
  tokenBudget?: number | null;
}
