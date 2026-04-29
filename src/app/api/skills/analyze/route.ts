import { NextRequest, NextResponse } from 'next/server';
import { requireAuthenticatedUserId } from '@/lib/auth/api-auth';
import { skillAnalysisService } from '@/lib/skill/skill-analysis-service';
import logger from '@/lib/logger';

/** GET: Return cached analysis if available */
export async function GET(request: NextRequest) {
  try {
    const auth = await requireAuthenticatedUserId(request);
    if ('response' in auth) return auth.response;

    const cached = skillAnalysisService.loadCache();
    return NextResponse.json({ analysis: cached });
  } catch (error) {
    logger.error({ error }, 'GET /api/skills/analyze error');
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

/** POST: Trigger analysis — returns immediately, progress via WebSocket */
export async function POST(request: NextRequest) {
  try {
    const auth = await requireAuthenticatedUserId(request);
    if ('response' in auth) return auth.response;

    let model: string | undefined;
    try {
      const body = await request.json();
      model = body.model;
    } catch { /* no body is fine */ }

    const started = await skillAnalysisService.startAnalysis(auth.userId, model);

    if (!started) {
      const state = skillAnalysisService.getState();
      return NextResponse.json(
        { status: 'already_running', currentState: state.status, startedAt: state.startedAt },
        { status: 409 }
      );
    }

    return NextResponse.json({ status: 'started' }, { status: 202 });
  } catch (error) {
    logger.error({ error }, 'POST /api/skills/analyze error');
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

/** DELETE: Cancel running analysis */
export async function DELETE(request: NextRequest) {
  try {
    const auth = await requireAuthenticatedUserId(request);
    if ('response' in auth) return auth.response;

    const cancelled = skillAnalysisService.cancelAnalysis();
    if (!cancelled) {
      return NextResponse.json({ status: 'not_running' }, { status: 404 });
    }
    return NextResponse.json({ status: 'cancelled' });
  } catch (error) {
    logger.error({ error }, 'DELETE /api/skills/analyze error');
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
