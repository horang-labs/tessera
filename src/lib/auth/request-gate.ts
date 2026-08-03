import { matchesAppSecret, APP_SECRET_HEADER } from './app-secret';
import { resolveServerDefaultUserId } from '../server-default-user';
import { verifyToken } from './jwt';
import { findUserById } from '../users';
import logger from '../logger';

export type RequestPurpose = 'http' | 'ws-upgrade';
export type CredentialKind = 'app' | 'device' | 'jwt';

export interface RequestGateInput {
  purpose: RequestPurpose;
  method: string;
  rawUrl: string;
  host: string;
  origin: string;
  cookies: Record<string, string>;
  headers: Record<string, string>;
}

export type RequestGateDecision =
  | {
      allow: true;
      userId: string;
      kind: CredentialKind;
      deviceId?: string;
    }
  | {
      allow: false;
      reason: string;
      status?: number;
      wsCloseCode?: number;
    };

function unauthorizedDecision(purpose: RequestPurpose): RequestGateDecision {
  return purpose === 'http'
    ? { allow: false, reason: 'unauthorized', status: 401 }
    : { allow: false, reason: 'unauthorized', wsCloseCode: 1008 };
}

function malformedDecision(purpose: RequestPurpose): RequestGateDecision {
  return purpose === 'http'
    ? { allow: false, reason: 'malformed-request', status: 400 }
    : { allow: false, reason: 'malformed-request', wsCloseCode: 1008 };
}

export function parseRequestUrl(input: Pick<RequestGateInput, 'host' | 'rawUrl'>): URL | null {
  if (!input.host.trim() || !input.rawUrl.trim()) return null;

  try {
    const baseUrl = new URL(`http://${input.host}`);
    return new URL(input.rawUrl, baseUrl);
  } catch {
    return null;
  }
}

export function hasPresentedCredential(
  input: Pick<RequestGateInput, 'cookies' | 'headers'>,
): boolean {
  return Boolean(
    input.headers[APP_SECRET_HEADER]
    || input.cookies.device
    || input.cookies.jwt,
  );
}

export async function evaluateRequest(input: RequestGateInput): Promise<RequestGateDecision> {
  if (!input.method.trim() || !parseRequestUrl(input)) {
    return malformedDecision(input.purpose);
  }

  if (await matchesAppSecret(input.headers[APP_SECRET_HEADER])) {
    const userId = await resolveServerDefaultUserId();
    if (userId) return { allow: true, userId, kind: 'app' };
  }

  // Device credentials are deliberately unmatched until ticket 08 adds the
  // revocable registry that is their source of truth.

  const jwt = input.cookies.jwt;
  if (jwt) {
    const payload = await verifyToken(jwt);
    if (payload) {
      const user = await findUserById(payload.sub);
      if (user) return { allow: true, userId: user.id, kind: 'jwt' };
    }
  }

  return unauthorizedDecision(input.purpose);
}

export async function evaluateRequestWithShadowLog(
  input: RequestGateInput,
): Promise<RequestGateDecision> {
  const decision = await evaluateRequest(input);
  logger.info({
    purpose: input.purpose,
    shadowKind: decision.allow ? decision.kind : null,
    shadowReason: decision.allow ? null : decision.reason,
  }, 'Request gate shadow decision');
  return decision;
}

export async function observeRequestGate(input: RequestGateInput): Promise<void> {
  try {
    await evaluateRequestWithShadowLog(input);
  } catch (error) {
    logger.warn({
      purpose: input.purpose,
      shadowKind: null,
      shadowReason: 'evaluation-error',
      error,
    }, 'Request gate shadow evaluation failed');
  }
}
