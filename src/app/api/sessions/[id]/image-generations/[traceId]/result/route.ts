import { NextRequest, NextResponse } from 'next/server';
import { requireAuthenticatedUserId } from '@/lib/auth/api-auth';
import * as dbSessions from '@/lib/db/sessions';
import { jsonError } from '@/lib/http/json-error';
import { readSessionImageGenerationTraces, readTraceImageBytes } from '@/lib/image-generation/session-traces';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; traceId: string }> },
): Promise<NextResponse> {
  const { id, traceId } = await params;
  const auth = await requireAuthenticatedUserId(request, {
    error: { code: 'unauthorized', message: 'Unauthorized' },
  });
  if ('response' in auth) return auth.response;
  const session = dbSessions.getSession(id);
  if (!session) return jsonError('not_found', 'Session not found', 404);
  const trace = (await readSessionImageGenerationTraces(session, auth.userId)).find((item) => item.id === traceId);
  if (!trace?.result) return jsonError('not_found', 'Generated image not found', 404);
  const image = await readTraceImageBytes(trace.result.locator, auth.userId);
  if (!image) return jsonError('file_not_found', 'Generated image is unavailable', 404);
  return new NextResponse(new Uint8Array(image.bytes).buffer, {
    headers: { 'Content-Type': image.mimeType, 'Cache-Control': 'private, max-age=30' },
  });
}
