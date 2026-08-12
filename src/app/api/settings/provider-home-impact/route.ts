import { NextRequest, NextResponse } from 'next/server';
import { requireAuthenticatedUserId } from '@/lib/auth/api-auth';
import { inspectProviderHomeChange } from '@/lib/settings/provider-home-change';
import type { AgentEnvironment } from '@/lib/settings/types';
import { SettingsManager } from '@/lib/settings/manager';
import logger from '@/lib/logger';

export async function GET(request: NextRequest) {
  try {
    const auth = await requireAuthenticatedUserId(request);
    if ('response' in auth) return auth.response;
    const target = request.nextUrl.searchParams.get('target');
    if (target !== 'native' && target !== 'wsl') {
      return NextResponse.json({ error: 'Invalid target Agent Environment.' }, { status: 400 });
    }
    const settings = await SettingsManager.load(auth.userId, { silent: true });
    const impact = await inspectProviderHomeChange(
      auth.userId,
      settings.agentEnvironment,
      target as AgentEnvironment,
    );
    return NextResponse.json({
      unavailableManagedSessionCount: impact.unavailableManagedSessionCount,
    });
  } catch (error) {
    logger.error({ error }, 'GET /api/settings/provider-home-impact error');
    return NextResponse.json({ error: 'Unable to inspect the target Codex home.' }, { status: 503 });
  }
}
