import { NextRequest, NextResponse } from 'next/server';
import { requireAuthenticatedUserId } from '@/lib/auth/api-auth';
import { getSession } from '@/lib/db/sessions';
import { readTerminalGoalHistory } from '@/lib/terminal/terminal-goal-history';

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
