import { NextResponse, type NextRequest } from 'next/server';
import { verifyToken } from '@/lib/auth/jwt';
import { isElectronAuthBypassEnabled } from '@/lib/auth/electron-mode';
import { getElectronAuthUserId } from '@/lib/auth/electron-user';

async function getAuthenticatedUserId(request: NextRequest): Promise<string | null> {
  if (isElectronAuthBypassEnabled()) {
    return getElectronAuthUserId();
  }

  const token = request.cookies.get('jwt')?.value;
  if (!token) return null;

  const payload = await verifyToken(token);
  return payload?.sub ?? null;
}

type AuthenticatedUser = { userId: string };
type UnauthorizedResponse = { response: NextResponse };

/**
 * Resolve the authenticated user ID or return a 401 response payload.
 * Keeps route handlers concise while preserving per-route unauthorized shape.
 */
export async function requireAuthenticatedUserId(
  request: NextRequest,
  unauthorizedBody: unknown = { error: 'Unauthorized' }
): Promise<AuthenticatedUser | UnauthorizedResponse> {
  const userId = await getAuthenticatedUserId(request);
  if (!userId) {
    return { response: NextResponse.json(unauthorizedBody, { status: 401 }) };
  }

  return { userId };
}
