import { v4 as uuidv4 } from 'uuid';

type Submission = { text: string; id: string; submittedAt: string };
const submissions = new Map<string, Submission>();
/** Preserve correlation across panel/Peek remounts after uncertain transport outcomes. */
export function getTerminalChatSubmission(sessionId: string, text: string): Submission {
  const existing = submissions.get(sessionId);
  if (existing?.text === text) return existing;
  const value = { text, id: uuidv4(), submittedAt: new Date().toISOString() };
  submissions.set(sessionId, value);
  return value;
}
export function clearTerminalChatSubmission(sessionId: string, id: string) {
  if (submissions.get(sessionId)?.id === id) submissions.delete(sessionId);
}
