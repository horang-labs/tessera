import { NextRequest, NextResponse } from 'next/server';
import { isOriginAllowed } from '@/lib/auth/allowed-origins';
import {
  claimPairingToken,
  DeviceRegistryError,
  listPairingRequests,
  PAIRING_REQUEST_COOKIE,
} from '@/lib/auth/device-registry';
import { getAuthCookieOptions } from '@/lib/auth/cookies';
import { requestGateInputFromNextRequest } from '@/lib/auth/next-request-gate';
import {
  clearPairingRedemptionFailures,
  recordPairingRedemptionFailure,
} from '@/lib/auth/pairing-rate-limit';
import {
  pairingRateLimitedResponse,
  requireLocalPairingManager,
} from '@/lib/auth/pairing-request-route';
import { TESSERA_REMOTE_ADDRESS_HEADER } from '@/lib/http/remote-address-header';
import logger from '@/lib/logger';

function browserName(userAgent: string): string {
  if (/edg\//i.test(userAgent)) return 'Microsoft Edge';
  if (/firefox|fxios/i.test(userAgent)) return 'Firefox';
  if (/chrome|crios/i.test(userAgent)) return 'Chrome';
  if (/safari/i.test(userAgent)) return 'Safari';
  return userAgent.trim().slice(0, 120) || 'Unknown browser';
}

function platformName(request: NextRequest, userAgent: string): string {
  const clientHint = request.headers.get('sec-ch-ua-platform')?.replaceAll('"', '').trim();
  if (clientHint) return clientHint.slice(0, 120);
  if (/iphone|ipad|ios/i.test(userAgent)) return 'iOS';
  if (/android/i.test(userAgent)) return 'Android';
  if (/macintosh|mac os/i.test(userAgent)) return 'macOS';
  if (/windows/i.test(userAgent)) return 'Windows';
  if (/linux/i.test(userAgent)) return 'Linux';
  return 'Unknown platform';
}

function failedClaimResponse(
  request: NextRequest,
  status: number,
  code: string,
  message: string,
): NextResponse {
  recordPairingRedemptionFailure();
  logger.warn({
    code,
    origin: request.headers.get('origin'),
    remoteAddress: request.headers.get(TESSERA_REMOTE_ADDRESS_HEADER) ?? 'unknown',
  }, 'Pairing request claim failed');
  return NextResponse.json({ error: message, code }, { status });
}

export async function GET(request: NextRequest) {
  const denial = await requireLocalPairingManager(request);
  if (denial) return denial;
  return NextResponse.json({ requests: await listPairingRequests() });
}

export async function POST(request: NextRequest) {
  const limited = pairingRateLimitedResponse();
  if (limited) return limited;

  const gateInput = requestGateInputFromNextRequest(request);
  if (!await isOriginAllowed(gateInput)) {
    return failedClaimResponse(request, 403, 'origin-not-allowed', 'Origin not allowed');
  }

  let body: { token?: unknown; name?: unknown };
  try {
    body = await request.json() as { token?: unknown; name?: unknown };
  } catch {
    return failedClaimResponse(request, 400, 'invalid-request', 'Invalid JSON body');
  }
  if (typeof body.token !== 'string' || !body.token) {
    return failedClaimResponse(request, 400, 'invalid-request', 'Pairing token is required');
  }
  if (body.name !== undefined && typeof body.name !== 'string') {
    return failedClaimResponse(request, 400, 'invalid-request', 'Device name must be a string');
  }

  const userAgent = request.headers.get('user-agent') ?? '';
  const platform = platformName(request, userAgent);
  try {
    const claim = await claimPairingToken({
      token: body.token,
      name: body.name ?? `Browser on ${platform}`,
      browser: browserName(userAgent),
      platform,
      remoteAddress: request.headers.get(TESSERA_REMOTE_ADDRESS_HEADER) ?? 'unknown',
    }, request.cookies.get(PAIRING_REQUEST_COOKIE)?.value);
    clearPairingRedemptionFailures();

    const response = NextResponse.json(
      { request: claim.request },
      { status: claim.created ? 201 : 200 },
    );
    const maxAge = Math.max(
      1,
      Math.ceil((Date.parse(claim.request.expiresAt) - Date.now()) / 1_000),
    );
    response.cookies.set(PAIRING_REQUEST_COOKIE, claim.pollingCredential, {
      ...getAuthCookieOptions(request, maxAge),
      path: '/api/pairing/requests',
    });
    logger.info({
      requestId: claim.request.id,
      deviceName: claim.request.name,
      browser: claim.request.browser,
      platform: claim.request.platform,
      remoteAddress: claim.request.remoteAddress,
      created: claim.created,
    }, 'Pairing request claimed');
    return response;
  } catch (error) {
    if (error instanceof DeviceRegistryError) {
      const status = error.code === 'pairing-expired'
        ? 410
        : error.code === 'pairing-used' || error.code === 'capacity-reached'
          ? 409
          : 401;
      return failedClaimResponse(request, status, error.code, error.message);
    }
    logger.error({ error }, 'Pairing request claim failed unexpectedly');
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
