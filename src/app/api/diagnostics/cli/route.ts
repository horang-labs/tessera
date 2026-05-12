import { NextRequest, NextResponse } from 'next/server';
import { requireAuthenticatedUserId } from '@/lib/auth/api-auth';
import { runCliDiagnostics, stripTelemetryRawLogs } from '@/lib/cli/diagnostics';
import { isServerTelemetryCaptureAllowed } from '@/lib/telemetry/server';
import {
  captureCliDiagnosticsTelemetry,
  parseSetupTelemetryTrigger,
} from '@/lib/telemetry/setup';
import logger from '@/lib/logger';

export async function POST(request: NextRequest) {
  try {
    const auth = await requireAuthenticatedUserId(request);
    if ('response' in auth) {
      return auth.response;
    }

    const source = request.nextUrl.searchParams.get('telemetry_source');
    const trigger = parseSetupTelemetryTrigger(
      request.nextUrl.searchParams.get('telemetry_trigger'),
    );
    const isSetupTelemetryRun = source === 'setup' && Boolean(trigger);

    if (isSetupTelemetryRun && !isServerTelemetryCaptureAllowed(request)) {
      return NextResponse.json({ skipped: true });
    }

    const report = await runCliDiagnostics(auth.userId, {
      storeLatest: !isSetupTelemetryRun,
      writeRawLogs: !isSetupTelemetryRun,
      captureTelemetryRawLog: false,
    });

    if (isSetupTelemetryRun && trigger) {
      await captureCliDiagnosticsTelemetry(report, { source: 'setup', trigger, request });
    } else {
      await captureCliDiagnosticsTelemetry(report, { source: 'settings', request });
    }

    return NextResponse.json({ report: stripTelemetryRawLogs(report) });
  } catch (error) {
    logger.error({ error }, 'POST /api/diagnostics/cli error');
    return NextResponse.json(
      { error: { code: 'diagnostics_failed', message: 'Failed to run CLI diagnostics' } },
      { status: 500 },
    );
  }
}
