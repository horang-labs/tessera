import { cliProviderRegistry } from '@/lib/cli/providers/registry';
import { reopenClaudeHookTurn } from '@/lib/cli/providers/claude-code/terminal-hook-lifecycle';
import { reopenCodexHookTurn } from '@/lib/cli/providers/codex/terminal-hook-lifecycle';
import { sendTerminalUserMessage, terminalManager } from './shared-terminal-manager';
import { TerminalGoalTracker, type TerminalGoalTarget } from './terminal-goal-tracker';

const GOAL_PROVIDERS: ReadonlySet<string> = new Set(['claude-code', 'codex']);

/** Providers whose PTY transcript records `/goal`. */
export function supportsTerminalGoal(providerId: string): boolean {
  return GOAL_PROVIDERS.has(providerId);
}

/** Lets a turn the CLI started by itself be tracked like a prompted one. */
export function reopenTerminalHookTurn(providerId: string, terminalId: string): void {
  if (providerId === 'codex') reopenCodexHookTurn(terminalId);
  else if (providerId === 'claude-code') reopenClaudeHookTurn(terminalId);
}

/**
 * Setting or resuming a goal starts a turn with no UserPromptSubmit. Show it as
 * running right away instead of waiting for a tool hook — Codex drops those
 * after a Stop until a new turn is opened.
 */
function markGoalTurnRunning(target: TerminalGoalTarget): void {
  reopenTerminalHookTurn(target.providerId, target.terminalId);
  if (terminalManager.getSessionStateForSession(target.sessionId, target.userId)?.status === 'running') {
    return;
  }
  const message = {
    type: 'session_state',
    sessionId: target.sessionId,
    terminalId: target.terminalId,
    status: 'running',
    hookEvent: 'GoalStarted',
    stateAt: Date.now(),
  } as const;
  if (terminalManager.recordSessionState(message, target.userId)) {
    sendTerminalUserMessage(target.userId, message);
  }
}

/** A stalled goal's turn ended without a Stop hook; close it like one. */
function completeStalledGoalTurn(target: TerminalGoalTarget): void {
  if (terminalManager.getSessionStateForSession(target.sessionId, target.userId)?.status !== 'running') {
    return;
  }
  const message = {
    type: 'session_state',
    sessionId: target.sessionId,
    terminalId: target.terminalId,
    status: 'completed',
    hookEvent: 'GoalStalled',
    stateAt: Date.now(),
  } as const;
  if (terminalManager.recordSessionState(message, target.userId)) {
    sendTerminalUserMessage(target.userId, message);
  }
}

function createTracker(): TerminalGoalTracker {
  return new TerminalGoalTracker({
    resolveTranscriptFile: async (target) => {
      const provider = cliProviderRegistry.getProvider(target.providerId);
      return await provider.resolveTerminalTranscriptFile?.({
        providerSessionId: target.providerSessionId,
        transcriptPath: target.transcriptPath,
        userId: target.userId,
      }) ?? null;
    },
    reduceLine: (providerId, current, line) => cliProviderRegistry
      .getProvider(providerId)
      .reduceTerminalGoalTranscriptLine?.(current, line),
    isLive: (target) => (
      terminalManager.getSessionIdForTerminal(target.terminalId, target.userId) === target.sessionId
    ),
    publish: (target, goal) => {
      sendTerminalUserMessage(target.userId, {
        type: 'terminal_goal',
        sessionId: target.sessionId,
        terminalId: target.terminalId,
        goal,
      });
    },
    onGoalStarted: markGoalTurnRunning,
    onGoalStalled: completeStalledGoalTurn,
  });
}

// One tracker per process, shared across Next's module instances like the
// terminal manager itself.
const TRACKER_KEY = Symbol.for('tessera.terminalGoalTracker');
const trackerGlobal = globalThis as unknown as Record<symbol, TerminalGoalTracker | undefined>;

export const terminalGoalTracker: TerminalGoalTracker = trackerGlobal[TRACKER_KEY]
  ?? (trackerGlobal[TRACKER_KEY] = createTracker());
