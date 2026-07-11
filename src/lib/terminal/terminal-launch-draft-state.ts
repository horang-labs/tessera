export interface TerminalLaunchDraft {
  draftAtLaunch: string;
  revision: number;
  sourceSessionId: string;
}

const revisionsBySession = new Map<string, number>();
const draftsByTerminal = new Map<string, TerminalLaunchDraft>();
const draftTimers = new Map<string, ReturnType<typeof setTimeout>>();
const DRAFT_TTL_MS = 5 * 60_000;

export function recordTerminalDraftEdit(sessionId: string): void {
  revisionsBySession.set(sessionId, (revisionsBySession.get(sessionId) ?? 0) + 1);
}

export function registerTerminalLaunchDraft(
  terminalId: string,
  sourceSessionId: string,
  draftAtLaunch: string,
): void {
  consumeTerminalLaunchDraft(terminalId);
  const draft: TerminalLaunchDraft = {
    draftAtLaunch,
    revision: revisionsBySession.get(sourceSessionId) ?? 0,
    sourceSessionId,
  };
  draftsByTerminal.set(terminalId, draft);
  const timer = setTimeout(() => {
    if (draftsByTerminal.get(terminalId) !== draft) return;
    consumeTerminalLaunchDraft(terminalId);
  }, DRAFT_TTL_MS);
  draftTimers.set(terminalId, timer);
}

export function consumeTerminalLaunchDraft(
  terminalId: string,
): TerminalLaunchDraft | undefined {
  const draft = draftsByTerminal.get(terminalId);
  draftsByTerminal.delete(terminalId);
  const timer = draftTimers.get(terminalId);
  if (timer !== undefined) clearTimeout(timer);
  draftTimers.delete(terminalId);
  return draft;
}

export function isTerminalLaunchDraftCurrent(draft: TerminalLaunchDraft): boolean {
  return (revisionsBySession.get(draft.sourceSessionId) ?? 0) === draft.revision;
}

export function shouldClearTerminalLaunchDraft(
  draft: TerminalLaunchDraft,
  currentDraft: string,
): boolean {
  return isTerminalLaunchDraftCurrent(draft) && currentDraft === draft.draftAtLaunch;
}
