import { NextRequest, NextResponse } from 'next/server';
import { requireAuthenticatedUserId } from '@/lib/auth/api-auth';
import { getSession } from '@/lib/db/sessions';
import { dismissTerminalGoal, readTerminalGoalHistory } from '@/lib/terminal/terminal-goal-history';
import { sendTerminalUserMessage } from '@/lib/terminal/shared-terminal-manager';
import type { TerminalGoalProvider } from '@/types/terminal-goal';

const GOAL_PROVIDERS: ReadonlySet<string> = new Set<TerminalGoalProvider>(['claude-code', 'codex']);

/**
 * GET /api/sessions/[id]/goal-history
 * Ended `/goal`s of a PTY session, newest first. Updates arrive over the
 * WebSocket as `terminal_goal_history`.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAuthenticatedUserId(req);
  if ('response' in auth) return auth.response;

  const { id } = await params;
  if (!id || id.includes('..') || id.includes('/')) {
    return NextResponse.json({ error: 'Invalid session ID' }, { status: 400 });
  }
  const session = getSession(id);
  if (!session || session.deleted === 1) {
    return NextResponse.json({ error: 'Session not found' }, { status: 404 });
  }
  return NextResponse.json({ history: readTerminalGoalHistory(id) });
}

/**
 * POST /api/sessions/[id]/goal-history
 * Body: { dismiss: { provider, setAt } } — the user closed an ended goal's
 * banner. Every window drops the session's goal mark.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAuthenticatedUserId(req);
  if ('response' in auth) return auth.response;

  const { id } = await params;
  if (!id || id.includes('..') || id.includes('/')) {
    return NextResponse.json({ error: 'Invalid session ID' }, { status: 400 });
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }
  const dismiss = (body as { dismiss?: { provider?: unknown; setAt?: unknown } } | null)?.dismiss;
  if (
    !dismiss
    || typeof dismiss.provider !== 'string' || !GOAL_PROVIDERS.has(dismiss.provider)
    || typeof dismiss.setAt !== 'number' || !Number.isFinite(dismiss.setAt)
  ) {
    return NextResponse.json({ error: 'Invalid dismiss' }, { status: 400 });
  }
  const session = getSession(id);
  if (!session || session.deleted === 1) {
    return NextResponse.json({ error: 'Session not found' }, { status: 404 });
  }

  const history = dismissTerminalGoal(id, dismiss.provider as TerminalGoalProvider, dismiss.setAt);
  if (history) {
    sendTerminalUserMessage(auth.userId, { type: 'terminal_goal_history', sessionId: id, history });
  }
  return NextResponse.json({ history: history ?? readTerminalGoalHistory(id) });
}
