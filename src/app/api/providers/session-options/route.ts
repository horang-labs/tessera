import { NextRequest, NextResponse } from 'next/server';
import { requireAuthenticatedUserId } from '@/lib/auth/api-auth';
import { getProviderSessionOptions } from '@/lib/cli/provider-session-options';
import logger from '@/lib/logger';

export async function GET(request: NextRequest) {
  try {
    const auth = await requireAuthenticatedUserId(request);
    if ('response' in auth) {
      return auth.response;
    }

    const providerId = request.nextUrl.searchParams.get('providerId')?.trim();
    if (!providerId) {
      return NextResponse.json({ error: 'providerId is required' }, { status: 400 });
    }

    const agentEnvironmentParam = request.nextUrl.searchParams.get('agentEnvironment')?.trim();
    const agentEnvironment =
      agentEnvironmentParam === 'native' || agentEnvironmentParam === 'wsl'
        ? agentEnvironmentParam
        : undefined;

    if (agentEnvironmentParam && !agentEnvironment) {
      return NextResponse.json({ error: 'agentEnvironment must be native or wsl' }, { status: 400 });
    }

    const options = await getProviderSessionOptions(providerId, auth.userId, agentEnvironment);
    return NextResponse.json(options);
  } catch (error) {
    logger.error({ error }, 'GET /api/providers/session-options error');
    return NextResponse.json(
      { error: 'Failed to load provider session options' },
      { status: 500 },
    );
  }
}
