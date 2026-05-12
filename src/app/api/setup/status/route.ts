import { NextRequest, NextResponse } from 'next/server';
import { requireAuthenticatedUserId } from '@/lib/auth/api-auth';
import { SettingsManager } from '@/lib/settings/manager';
import { buildSetupStatus } from '@/lib/setup/setup-status';
import {
  captureSetupStatusTelemetry,
  parseSetupTelemetryTrigger,
} from '@/lib/telemetry/setup';
import logger from '@/lib/logger';

export async function GET(request: NextRequest) {
  try {
    const auth = await requireAuthenticatedUserId(request);
    if ('response' in auth) {
      return auth.response;
    }

    const settings = await SettingsManager.load(auth.userId);
    const status = await buildSetupStatus(settings, { userId: auth.userId });
    const source = request.nextUrl.searchParams.get('telemetry_source');
    const trigger = parseSetupTelemetryTrigger(
      request.nextUrl.searchParams.get('telemetry_trigger'),
    );

    if (source === 'setup' && trigger) {
      void captureSetupStatusTelemetry(status, { trigger, request });
    }

    return NextResponse.json(status);
  } catch (error) {
    logger.error({ error }, 'GET /api/setup/status error');
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 },
    );
  }
}
