import { NextRequest, NextResponse } from 'next/server';
import { requireAuthenticatedUserId } from '@/lib/auth/api-auth';
import * as dbSessions from '@/lib/db/sessions';
import { jsonError } from '@/lib/http/json-error';
import { readSessionImageGenerationTraces, readTraceImageBytes } from '@/lib/image-generation/session-traces';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; traceId: string; inputIndex: string }> },
): Promise<NextResponse> {
  const { id, traceId, inputIndex } = await params;
  const auth = await requireAuthenticatedUserId(request, {
    error: { code: 'unauthorized', message: 'Unauthorized' },
  });
  if ('response' in auth) return auth.response;
  const session = dbSessions.getSession(id);
  if (!session) return jsonError('not_found', 'Session not found', 404);
  const index = Number(inputIndex);
  if (!Number.isSafeInteger(index) || index < 0) return jsonError('invalid_params', 'Invalid input index', 400);
  const trace = (await readSessionImageGenerationTraces(session, auth.userId)).find((item) => item.id === traceId);
  const locator = trace?.inputs[index]?.locator;
  if (!locator) return jsonError('not_found', 'Input image not found', 404);
  const image = await readTraceImageBytes(locator, auth.userId);
  if (!image) return jsonError('file_not_found', 'Input image is unavailable', 404);
  return new NextResponse(new Uint8Array(image.bytes).buffer, {
    headers: { 'Content-Type': image.mimeType, 'Cache-Control': 'private, max-age=30' },
  });
}
