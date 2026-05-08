import { NextRequest, NextResponse } from 'next/server';
import { requireAuthenticatedUserId } from '@/lib/auth/api-auth';
import { exportLatestCliDiagnosticReport } from '@/lib/cli/diagnostics';
import { jsonError } from '@/lib/http/json-error';
import logger from '@/lib/logger';

export async function POST(request: NextRequest) {
  try {
    const auth = await requireAuthenticatedUserId(request);
    if ('response' in auth) {
      return auth.response;
    }

    const exportResult = await exportLatestCliDiagnosticReport(auth.userId);
    return NextResponse.json(exportResult);
  } catch (error) {
    const message = (error as Error).message;
    if (message === 'No diagnostic report found') {
      return jsonError('no_diagnostic_report', 'Run diagnostics before exporting a report', 409);
    }

    logger.error({ error }, 'POST /api/diagnostics/cli/export error');
    return jsonError('diagnostic_export_failed', 'Failed to export CLI diagnostics report', 500);
  }
}
