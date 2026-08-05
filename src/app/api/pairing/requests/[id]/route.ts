import { NextRequest, NextResponse } from 'next/server';
import {
  decidePairingRequest,
  DEVICE_TOKEN_COOKIE,
  DeviceRegistryError,
  listPairingRequests,
  PAIRING_REQUEST_COOKIE,
  receivePairingDecision,
} from '@/lib/auth/device-registry';
import { getAuthCookieOptions } from '@/lib/auth/cookies';
import { isPairingDecision } from '@/lib/auth/pairing-contract';
import {
  clearPairingRedemptionFailures,
  recordPairingRedemptionFailure,
} from '@/lib/auth/pairing-rate-limit';
import {
  pairingRateLimitedResponse,
  requireLocalPairingManager,
} from '@/lib/auth/pairing-request-route';
import logger from '@/lib/logger';

const DEVICE_COOKIE_MAX_AGE_SECONDS = 10 * 365 * 24 * 60 * 60;

function terminalPairingCookie(response: NextResponse, request: NextRequest): void {
  response.cookies.set(PAIRING_REQUEST_COOKIE, '', {
    ...getAuthCookieOptions(request, 0),
    path: '/api/pairing/requests',
  });
}

async function pairingRequestLogContext(requestId: string) {
  const pairingRequest = (await listPairingRequests()).find(({ id }) => id === requestId);
  return {
    requestId,
    ...(pairingRequest ? {
      deviceName: pairingRequest.name,
      browser: pairingRequest.browser,
      platform: pairingRequest.platform,
      remoteAddress: pairingRequest.remoteAddress,
    } : {}),
  };
}

async function logPairingDecisionRejection(requestId: string, code: string): Promise<void> {
  logger.warn({
    ...await pairingRequestLogContext(requestId),
    code,
  }, 'Pairing decision rejected');
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const limited = pairingRateLimitedResponse();
  if (limited) return limited;

  const { id } = await params;
  let result: Awaited<ReturnType<typeof receivePairingDecision>>;
  try {
    result = await receivePairingDecision(
      id,
      request.cookies.get(PAIRING_REQUEST_COOKIE)?.value,
    );
  } catch (error) {
    if (error instanceof DeviceRegistryError) {
      const status = error.code === 'capacity-reached' ? 409 : 400;
      logger.warn({
        ...await pairingRequestLogContext(id),
        code: error.code,
      }, 'Pairing request redemption failed');
      return NextResponse.json({ error: error.message, code: error.code }, { status });
    }
    logger.error({
      ...await pairingRequestLogContext(id),
      error,
    }, 'Pairing request redemption failed unexpectedly');
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
  const statusCode = result.status === 'expired'
    ? 410
    : result.status === 'used'
      ? 409
      : 200;
  const response = NextResponse.json(
    result.status === 'redeemed'
      ? {
          status: 'approved',
          expiresAt: result.expiresAt,
          device: {
            id: result.device.id,
            name: result.device.name,
            registeredAt: result.device.registeredAt,
            lastSeenAt: result.device.lastSeenAt,
          },
        }
      : result,
    { status: statusCode },
  );

  if (result.status === 'redeemed') {
    response.cookies.set(
      DEVICE_TOKEN_COOKIE,
      result.device.token,
      getAuthCookieOptions(request, DEVICE_COOKIE_MAX_AGE_SECONDS),
    );
    terminalPairingCookie(response, request);
    clearPairingRedemptionFailures();
    logger.info({ requestId: id, deviceId: result.device.id }, 'Pairing request redeemed');
  } else if (result.status === 'pending') {
    clearPairingRedemptionFailures();
  } else {
    if (result.status === 'expired' || result.status === 'used') {
      recordPairingRedemptionFailure();
    }
    terminalPairingCookie(response, request);
    logger.warn({
      ...await pairingRequestLogContext(id),
      status: result.status,
    }, 'Pairing request finished without a device');
  }
  return response;
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const denial = await requireLocalPairingManager(request);
  if (denial) {
    await logPairingDecisionRejection(id, 'authorization-failed');
    return denial;
  }

  let body: { decision?: unknown };
  try {
    body = await request.json() as { decision?: unknown };
  } catch {
    await logPairingDecisionRejection(id, 'invalid-request');
    return NextResponse.json(
      { error: 'Invalid JSON body', code: 'invalid-request' },
      { status: 400 },
    );
  }
  if (!isPairingDecision(body.decision)) {
    await logPairingDecisionRejection(id, 'invalid-request');
    return NextResponse.json(
      { error: 'Decision must be approve or deny', code: 'invalid-request' },
      { status: 400 },
    );
  }

  try {
    const pairingRequest = await decidePairingRequest(id, body.decision);
    logger.info({
      requestId: pairingRequest.id,
      decision: body.decision,
      deviceName: pairingRequest.name,
      browser: pairingRequest.browser,
      platform: pairingRequest.platform,
      remoteAddress: pairingRequest.remoteAddress,
    }, 'Pairing request decided');
    return NextResponse.json({ request: pairingRequest });
  } catch (error) {
    if (error instanceof DeviceRegistryError) {
      const status = error.code === 'pairing-request-invalid'
        ? 404
        : error.code === 'pairing-expired'
          ? 410
          : 409;
      logger.warn({
        ...await pairingRequestLogContext(id),
        decision: body.decision,
        code: error.code,
      }, 'Pairing decision failed');
      return NextResponse.json({ error: error.message, code: error.code }, { status });
    }
    logger.error({
      ...await pairingRequestLogContext(id),
      decision: body.decision,
      error,
    }, 'Pairing decision failed unexpectedly');
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
