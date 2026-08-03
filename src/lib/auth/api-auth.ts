import { NextResponse, type NextRequest } from 'next/server';
import { isElectronAuthBypassEnabled } from '@/lib/auth/electron-mode';
import { getElectronAuthUserId } from '@/lib/electron-user';
import { requestGateInputFromNextRequest } from '@/lib/auth/next-request-gate';
import {
  evaluateRequestAndLog,
  isOriginDenial,
  observeRequestGate,
  type CredentialKind,
} from '@/lib/auth/request-gate';

type AuthenticatedUser = { userId: string; kind: CredentialKind; deviceId?: string };
type AuthenticationResult = AuthenticatedUser | { originDenied: true } | null;

async function getAuthenticatedUser(request: NextRequest): Promise<AuthenticationResult> {
  const input = requestGateInputFromNextRequest(request);

  if (isElectronAuthBypassEnabled()) {
    const shadowDecision = await observeRequestGate(input);
    if (isOriginDenial(shadowDecision)) {
      return { originDenied: true };
    }
    return { userId: await getElectronAuthUserId(), kind: 'app' };
  }

  const decision = await evaluateRequestAndLog(input);
  if (decision.allow) {
    return {
      userId: decision.userId,
      kind: decision.kind,
      ...(decision.deviceId ? { deviceId: decision.deviceId } : {}),
    };
  }
  return isOriginDenial(decision) ? { originDenied: true } : null;
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
  if ('originDenied' in authenticated) {
    return {
      response: NextResponse.json(
        { error: 'Origin not allowed' },
        { status: 403 },
      ),
    };
  }

  return authenticated;
}
