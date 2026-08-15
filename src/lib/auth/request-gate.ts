import { matchesAppSecret, APP_SECRET_HEADER } from './app-secret';
import { resolveServerDefaultUserId } from '../server-default-user';
import { verifyToken } from './jwt';
import { findUserById } from '../users';
import { isElectronRuntime } from '../electron-runtime';
import logger from '../logger';
import { isOriginAllowed } from './allowed-origins';
import { DEVICE_TOKEN_COOKIE, resolveDeviceToken } from './device-registry';

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
      reason: RequestDenialReason;
      status: number;
      wsCloseCode?: never;
    }
  | {
      allow: false;
      reason: RequestDenialReason;
      status?: never;
      wsCloseCode: number;
    };

export type RequestDenialReason =
  | 'unauthorized'
  | 'malformed-request'
  | 'origin-not-allowed';

export function isOriginDenial(decision: RequestGateDecision | null): boolean {
  return Boolean(
    decision
    && !decision.allow
    && decision.reason === 'origin-not-allowed',
  );
}

export function requestGateLogContext(input: RequestGateInput) {
  return {
    purpose: input.purpose,
    method: input.method,
    host: input.host,
    origin: input.origin,
  };
}

function denyRequest(
  purpose: RequestPurpose,
  reason: RequestDenialReason,
): RequestGateDecision {
  return purpose === 'http'
    ? {
        allow: false,
        reason,
        status: reason === 'malformed-request'
          ? 400
          : reason === 'origin-not-allowed'
            ? 403
            : 401,
      }
    : { allow: false, reason, wsCloseCode: 1008 };
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
    || input.cookies[DEVICE_TOKEN_COOKIE]
    || input.cookies.jwt,
  );
}

export async function evaluateRequest(input: RequestGateInput): Promise<RequestGateDecision> {
  if (!input.method.trim() || !parseRequestUrl(input)) {
    return denyRequest(input.purpose, 'malformed-request');
  }

  if (!await isOriginAllowed(input)) {
    return denyRequest(input.purpose, 'origin-not-allowed');
  }

  if (await matchesAppSecret(input.headers[APP_SECRET_HEADER])) {
    const userId = await resolveServerDefaultUserId();
    if (userId) return { allow: true, userId, kind: 'app' };
  }

  const deviceToken = input.cookies[DEVICE_TOKEN_COOKIE];
  const device = deviceToken
    ? await resolveDeviceToken(deviceToken)
    : null;
  if (device) {
    const userId = await resolveServerDefaultUserId();
    if (userId) {
      return { allow: true, userId, kind: 'device', deviceId: device.id };
    }
  }

  const jwt = input.cookies.jwt;
  if (jwt) {
    const payload = await verifyToken(jwt);
    if (payload) {
      const user = await findUserById(payload.sub);
      if (user) {
        const userId = isElectronRuntime()
          ? await resolveServerDefaultUserId()
          : user.id;
        if (userId) return { allow: true, userId, kind: 'jwt' };
      }
    }
  }

  return denyRequest(input.purpose, 'unauthorized');
}

export async function evaluateRequestAndLog(
  input: RequestGateInput,
): Promise<RequestGateDecision> {
  const decision = await evaluateRequest(input);
  logger.info({
    ...requestGateLogContext(input),
    kind: decision.allow ? decision.kind : null,
    reason: decision.allow ? null : decision.reason,
  }, 'Request gate decision');
  return decision;
}
