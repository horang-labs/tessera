import { NextRequest, NextResponse } from 'next/server';
import { requestGateInputFromNextRequest } from './next-request-gate';
import { getPairingRedemptionRateLimit } from './pairing-rate-limit';
import { evaluateRequestAndLog } from './request-gate';

export async function requireLocalPairingManager(
  request: NextRequest,
): Promise<NextResponse | null> {
  const decision = await evaluateRequestAndLog(requestGateInputFromNextRequest(request));
  if (!decision.allow) {
    return NextResponse.json(
      { error: 'Authentication required', code: decision.reason },
      { status: 'status' in decision ? decision.status : 401 },
    );
  }
  if (decision.kind !== 'app') {
    return NextResponse.json(
      { error: 'Pairing requests can only be managed from the Tessera app', code: 'app_required' },
      { status: 403 },
    );
  }
  return null;
}

export function pairingRateLimitedResponse(): NextResponse | null {
  const rateLimit = getPairingRedemptionRateLimit();
  if (!rateLimit.limited) return null;
  const response = NextResponse.json(
    { error: 'Too many pairing attempts', code: 'rate-limited' },
    { status: 429 },
  );
  response.headers.set('Retry-After', String(rateLimit.retryAfterSeconds));
  return response;
}
