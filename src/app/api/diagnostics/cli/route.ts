import { NextRequest, NextResponse } from 'next/server';
import { requireAuthenticatedUserId } from '@/lib/auth/api-auth';
import { runCliDiagnostics } from '@/lib/cli/diagnostics';
import logger from '@/lib/logger';

export async function POST(request: NextRequest) {
  try {
    const auth = await requireAuthenticatedUserId(request);
    if ('response' in auth) {
      return auth.response;
    }

    const report = await runCliDiagnostics(auth.userId);
    return NextResponse.json({ report });
  } catch (error) {
    logger.error({ error }, 'POST /api/diagnostics/cli error');
    return NextResponse.json(
      { error: { code: 'diagnostics_failed', message: 'Failed to run CLI diagnostics' } },
      { status: 500 },
    );
  }
}
