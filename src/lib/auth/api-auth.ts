import { NextResponse, type NextRequest } from 'next/server';
import { isElectronAuthBypassEnabled } from '@/lib/auth/electron-mode';
import { getElectronAuthUserId } from '@/lib/electron-user';
import { requestGateInputFromNextRequest } from '@/lib/auth/next-request-gate';
import {
  evaluateRequestWithShadowLog,
  observeRequestGate,
  type CredentialKind,
} from '@/lib/auth/request-gate';

type AuthenticatedUser = { userId: string; kind: CredentialKind };

async function getAuthenticatedUser(request: NextRequest): Promise<AuthenticatedUser | null> {
  const input = requestGateInputFromNextRequest(request);

  if (isElectronAuthBypassEnabled()) {
    await observeRequestGate(input);
    return { userId: await getElectronAuthUserId(), kind: 'app' };
  }

  const decision = await evaluateRequestWithShadowLog(input);
  return decision.allow
    ? { userId: decision.userId, kind: decision.kind }
    : null;
}

type UnauthorizedResponse = { response: NextResponse };

/**
 * Resolve the authenticated user ID or return a 401 response payload.
 * Keeps route handlers concise while preserving per-route unauthorized shape.
 */
export async function requireAuthenticatedUserId(
  request: NextRequest,
  unauthorizedBody: unknown = { error: 'Unauthorized' }
): Promise<AuthenticatedUser | UnauthorizedResponse> {
  const authenticated = await getAuthenticatedUser(request);
  if (!authenticated) {
    return { response: NextResponse.json(unauthorizedBody, { status: 401 }) };
  }

  return authenticated;
}
