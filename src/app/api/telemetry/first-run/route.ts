import { NextRequest, NextResponse } from 'next/server';
import { getServerHostInfo } from '@/lib/system/server-host';
import { markTelemetryFirstRun, type FirstRunSkipReason } from '@/lib/telemetry/server-state';
import logger from '@/lib/logger';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({})) as {
      status?: unknown;
      skipReason?: unknown;
    };
    const requestedStatus = body.status === 'captured' ? 'captured' : 'skipped';
    const hostInfo = getServerHostInfo();
    const status = hostInfo.telemetryDisabledByEnv ? 'skipped' : requestedStatus;
    const skipReason = hostInfo.telemetryDisabledByEnv
      ? 'telemetry_disabled_by_env'
      : normalizeFirstRunSkipReason(body.skipReason);
    const state = await markTelemetryFirstRun(status, { skipReason });
    return NextResponse.json({ success: true, state });
  } catch (error) {
    logger.error({ error }, 'POST /api/telemetry/first-run error');
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 },
    );
  }
}

function normalizeFirstRunSkipReason(value: unknown): FirstRunSkipReason | null {
  if (
    value === 'client_disabled'
    || value === 'existing_install_data'
    || value === 'telemetry_disabled_by_env'
    || value === 'unknown'
  ) {
    return value;
  }
  return null;
}
