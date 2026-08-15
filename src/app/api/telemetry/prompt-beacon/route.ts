import { NextRequest, NextResponse } from 'next/server';
import { requireAuthenticatedUserId } from '@/lib/auth/api-auth';
import { triggerModelConfigRefresh } from '@/lib/model-config/refresh';
import { normalizeTelemetryProvider } from '@/lib/telemetry/usage-dimensions';

/**
 * Records a content-free proof that the app reached a prompt submission boundary.
 * This route intentionally accepts no payload and is independent of PostHog consent.
 * The only caller-supplied dimension is a closed provider enum.
 */
export async function POST(req: NextRequest) {
  const auth = await requireAuthenticatedUserId(req);
  if ('response' in auth) return auth.response;

  const provider = normalizeTelemetryProvider(req.headers.get('x-tessera-provider'));
  await triggerModelConfigRefresh('prompt', { provider });
  return new NextResponse(null, { status: 204 });
}
