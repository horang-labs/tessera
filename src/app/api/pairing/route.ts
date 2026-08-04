import { NextRequest, NextResponse } from 'next/server';
import { requestGateInputFromNextRequest } from '@/lib/auth/next-request-gate';
import { evaluateRequestAndLog } from '@/lib/auth/request-gate';
import {
  DeviceRegistryError,
  getPairingStatus,
  listDevices,
  MAX_PAIRED_DEVICES,
} from '@/lib/auth/device-registry';
import logger from '@/lib/logger';
import {
  createPairingPresentation,
  PairingAction,
  PairingPresentationError,
} from '@/lib/auth/pairing-presentation';

function isLoopbackBrowserRequest(request: NextRequest): boolean {
  const hostname = request.nextUrl.hostname.toLowerCase();
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

async function requirePairingManager(request: NextRequest) {
  // Electron's App secret or an authenticated loopback browser may mint a
  // credential. Paired devices and remote JWT sessions remain unable to do so.
  const decision = await evaluateRequestAndLog(requestGateInputFromNextRequest(request));
  if (!decision.allow) {
    return NextResponse.json(
      { error: 'Authentication required', code: decision.reason },
      { status: 'status' in decision ? decision.status : 401 },
    );
  }
  if (
    decision.kind !== 'app'
    && !(decision.kind === 'jwt' && isLoopbackBrowserRequest(request))
  ) {
    return NextResponse.json(
      { error: 'Pairing can only be managed from the Tessera app', code: 'app_required' },
      { status: 403 },
    );
  }
  return null;
}

async function pairingResponse(
  action: PairingAction,
  status = 200,
): Promise<NextResponse> {
  return NextResponse.json(await createPairingPresentation(action), { status });
}

function pairingErrorResponse(error: { message: string; code: string }): NextResponse {
  return NextResponse.json(
    { error: error.message, code: error.code },
    { status: 409 },
  );
}

export async function GET(request: NextRequest) {
  const denial = await requirePairingManager(request);
  if (denial) return denial;
  const [pairing, devices] = await Promise.all([
    getPairingStatus(),
    listDevices(),
  ]);
  return NextResponse.json({ pairing, deviceCount: devices.length, maxDevices: MAX_PAIRED_DEVICES });
}

export async function POST(request: NextRequest) {
  const denial = await requirePairingManager(request);
  if (denial) return denial;
  try {
    return await pairingResponse('issue', 201);
  } catch (error) {
    if (error instanceof PairingPresentationError) return pairingErrorResponse(error);
    if (error instanceof DeviceRegistryError) return pairingErrorResponse(error);
    logger.error({ error }, 'Pairing token issuance failed');
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
export async function PUT(request: NextRequest) {
  const denial = await requirePairingManager(request);
  if (denial) return denial;
  try {
    return await pairingResponse('rotate');
  } catch (error) {
    if (error instanceof PairingPresentationError) return pairingErrorResponse(error);
    if (error instanceof DeviceRegistryError) return pairingErrorResponse(error);
    logger.error({ error }, 'Pairing token rotation failed');
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
