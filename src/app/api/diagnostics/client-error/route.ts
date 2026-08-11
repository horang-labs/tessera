import { NextRequest, NextResponse } from 'next/server';
import { requireAuthenticatedUserId } from '@/lib/auth/api-auth';
import { DEBUG_DIAGNOSTICS } from '@/lib/debug-diagnostics';
import logger from '@/lib/logger';

const MAX_TEXT_CHARS = 20_000;
const MAX_METADATA_CHARS = 2_000;

interface ClientErrorPayload {
  level?: unknown;
  text?: unknown;
  url?: unknown;
  userAgent?: unknown;
}

function boundedString(value: unknown, limit: number): string | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  return value.slice(0, limit);
}

export async function POST(request: NextRequest) {
  if (!DEBUG_DIAGNOSTICS) {
    return new NextResponse(null, { status: 404 });
  }

  const auth = await requireAuthenticatedUserId(request);
  if ('response' in auth) return auth.response;

  let payload: ClientErrorPayload;
  try {
    payload = await request.json() as ClientErrorPayload;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const text = boundedString(payload.text, MAX_TEXT_CHARS);
  if (payload.level !== 'error' || !text) {
    return NextResponse.json({ error: 'Invalid client error report' }, { status: 400 });
  }

  logger.error({
    purpose: 'remote-browser-client-error',
    userId: auth.userId,
    credentialKind: auth.kind,
    deviceId: auth.deviceId,
    clientUrl: boundedString(payload.url, MAX_METADATA_CHARS),
    userAgent: boundedString(payload.userAgent, MAX_METADATA_CHARS),
    clientError: text,
  }, 'Remote browser client error');

  return NextResponse.json({ received: true });
}
