import { NextRequest, NextResponse } from 'next/server';
import { requireAuthenticatedUserId } from '@/lib/auth/api-auth';
import { triggerModelConfigRefresh } from '@/lib/model-config/refresh';

/**
 * Records a content-free proof that the app reached a prompt submission boundary.
 * This route intentionally accepts no payload and is independent of PostHog consent.
 */
export async function POST(req: NextRequest) {
  const auth = await requireAuthenticatedUserId(req);
  if ('response' in auth) return auth.response;

  await triggerModelConfigRefresh('prompt');
  return new NextResponse(null, { status: 204 });
}
