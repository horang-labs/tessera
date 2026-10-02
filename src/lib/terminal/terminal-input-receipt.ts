import type { TerminalInputResult } from '@/lib/automation/contracts';
import { AutomationInputError } from '@/lib/automation/input-error';
import { TerminalSessionInputError, type TerminalManager } from './terminal-manager';

/** A receipt describes host acceptance, including a synchronous writer that may have partially acted. */
export function writeTerminalInput(manager: TerminalManager, userId: string, connectionId: string, request: {
  requestId: string; terminalId: string; surfaceId: string; data: string; inputEpoch?: string;
}): TerminalInputResult {
  const sessionId = manager.getSessionIdForTerminal(request.terminalId, userId);
  let outcome: TerminalInputResult['outcome'] = 'rejected';
  let code: string | undefined;
  try {
    outcome = manager.write(request.terminalId, userId, connectionId, request.surfaceId, request.data, request.inputEpoch) ? 'accepted' : 'rejected';
    if (outcome === 'rejected') code = 'INPUT_NOT_ACCEPTED';
  } catch (error) {
    outcome = error instanceof AutomationInputError || error instanceof TerminalSessionInputError ? 'rejected' : 'unknown';
    code = error instanceof AutomationInputError ? error.code : 'INPUT_NOT_ACCEPTED';
  }
  return { requestId: request.requestId, terminalId: request.terminalId, surfaceId: request.surfaceId,
    outcome, ...(code ? { code } : {}), inputOwnership: manager.automation.ownership(userId, sessionId ?? '') };
}
