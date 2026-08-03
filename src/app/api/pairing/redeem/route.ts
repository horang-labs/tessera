import { NextRequest, NextResponse } from 'next/server';
import {
  DEVICE_TOKEN_COOKIE,
  DeviceRegistryError,
  redeemPairingToken,
} from '@/lib/auth/device-registry';
import { getAuthCookieOptions } from '@/lib/auth/cookies';
import {
  clearPairingRedemptionFailures,
  getPairingRedemptionRateLimit,
  recordPairingRedemptionFailure,
} from '@/lib/auth/pairing-rate-limit';
import logger from '@/lib/logger';
import { TESSERA_REMOTE_ADDRESS_HEADER } from '@/lib/http/remote-address-header';

const DEVICE_COOKIE_MAX_AGE_SECONDS = 10 * 365 * 24 * 60 * 60;

function requestLogContext(request: NextRequest) {
  return {
    origin: request.headers.get('origin'),
    remoteAddress: request.headers.get(TESSERA_REMOTE_ADDRESS_HEADER)
      ?? request.headers.get('x-real-ip'),
    forwardedFor: request.headers.get('x-forwarded-for'),
  };
}

function failedResponse(
  request: NextRequest,
  status: number,
  code: string,
  message: string,
): NextResponse {
  recordPairingRedemptionFailure();
  logger.warn({ ...requestLogContext(request), code }, 'Pairing redemption failed');
  return NextResponse.json({ error: message, code }, { status });
}

export async function POST(request: NextRequest) {
  const rateLimit = getPairingRedemptionRateLimit();
  if (rateLimit.limited) {
    logger.warn(requestLogContext(request), 'Pairing redemption rate limited');
    const response = NextResponse.json(
      { error: 'Too many pairing attempts', code: 'rate-limited' },
      { status: 429 },
    );
    response.headers.set('Retry-After', String(rateLimit.retryAfterSeconds));
    return response;
  }

  let body: { token?: unknown; name?: unknown };
  try {
    body = await request.json() as { token?: unknown; name?: unknown };
  } catch {
    return failedResponse(request, 400, 'invalid-request', 'Invalid JSON body');
  }
  if (typeof body.token !== 'string' || !body.token) {
    return failedResponse(request, 400, 'invalid-request', 'Pairing token is required');
  }
  if (body.name !== undefined && typeof body.name !== 'string') {
    return failedResponse(request, 400, 'invalid-request', 'Device name must be a string');
  }

  try {
    const redeemed = await redeemPairingToken(
      body.token,
      body.name ?? 'Paired device',
    );
    clearPairingRedemptionFailures();
    const { token, ...device } = redeemed;
    const response = NextResponse.json({ success: true, device }, { status: 201 });
    response.cookies.set(
      DEVICE_TOKEN_COOKIE,
      token,
      getAuthCookieOptions(request, DEVICE_COOKIE_MAX_AGE_SECONDS),
    );
    return response;
  } catch (error) {
    if (error instanceof DeviceRegistryError) {
      const status = error.code === 'pairing-expired'
        ? 410
        : error.code === 'capacity-reached'
          ? 409
          : 401;
      return failedResponse(request, status, error.code, error.message);
    }
    logger.error({ ...requestLogContext(request), error }, 'Pairing redemption failed unexpectedly');
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
