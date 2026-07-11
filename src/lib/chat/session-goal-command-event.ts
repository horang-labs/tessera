export const SESSION_GOAL_COMMAND_INSERT_EVENT = 'tessera:session-goal-command-insert';
export const SESSION_GOAL_COMMAND_EDIT_EVENT = 'tessera:session-goal-command-edit';

export function emitSessionGoalCommandInsert(sessionId: string): void {
  window.dispatchEvent(new CustomEvent(SESSION_GOAL_COMMAND_INSERT_EVENT, {
    detail: { sessionId },
  }));
}

export function emitSessionGoalCommandEdit(sessionId: string): void {
  window.dispatchEvent(new CustomEvent(SESSION_GOAL_COMMAND_EDIT_EVENT, {
    detail: { sessionId },
  }));
}

export function getSessionGoalCommandInsertSessionId(event: Event): string | null {
  return event instanceof CustomEvent && typeof event.detail?.sessionId === 'string'
    ? event.detail.sessionId
    : null;
}
export const getSessionGoalCommandEditSessionId = getSessionGoalCommandInsertSessionId;
