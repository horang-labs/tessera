import { NextRequest, NextResponse } from 'next/server';
import { requestGateInputFromNextRequest } from '@/lib/auth/next-request-gate';
import { evaluateRequestAndLog } from '@/lib/auth/request-gate';
import {
  DeviceRegistryError,
  getPairingStatus,
  issuePairingToken,
  listDevices,
  MAX_PAIRED_DEVICES,
  rotatePairingToken,
} from '@/lib/auth/device-registry';
import logger from '@/lib/logger';

async function requireAppCredential(request: NextRequest) {
  // Pairing is the one endpoint that must never inherit the migration bypass:
  // only Electron's injected App secret may mint another credential.
  const decision = await evaluateRequestAndLog(requestGateInputFromNextRequest(request));
  if (!decision.allow) {
    return NextResponse.json(
      { error: 'Authentication required', code: decision.reason },
      { status: 'status' in decision ? decision.status : 401 },
    );
  }
  if (decision.kind !== 'app') {
    return NextResponse.json(
      { error: 'Pairing can only be managed from the Tessera app', code: 'app_required' },
      { status: 403 },
    );
  }
  return null;
}

function registryErrorResponse(error: DeviceRegistryError): NextResponse {
  return NextResponse.json(
    { error: error.message, code: error.code },
    { status: 409 },
  );
}

export async function GET(request: NextRequest) {
  const denial = await requireAppCredential(request);
  if (denial) return denial;
  const [pairing, devices] = await Promise.all([
    getPairingStatus(),
    listDevices(),
  ]);
  return NextResponse.json({ pairing, deviceCount: devices.length, maxDevices: MAX_PAIRED_DEVICES });
}

export async function POST(request: NextRequest) {
  const denial = await requireAppCredential(request);
  if (denial) return denial;
  try {
    const pairing = await issuePairingToken();
    return NextResponse.json({
      pairingToken: pairing.token,
      createdAt: pairing.createdAt,
      expiresAt: pairing.expiresAt,
    }, { status: 201 });
  } catch (error) {
    if (error instanceof DeviceRegistryError) return registryErrorResponse(error);
    logger.error({ error }, 'Pairing token issuance failed');
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
export async function PUT(request: NextRequest) {
  const denial = await requireAppCredential(request);
  if (denial) return denial;
  try {
    const pairing = await rotatePairingToken();
    return NextResponse.json({
      pairingToken: pairing.token,
      createdAt: pairing.createdAt,
      expiresAt: pairing.expiresAt,
    });
  } catch (error) {
    if (error instanceof DeviceRegistryError) return registryErrorResponse(error);
    logger.error({ error }, 'Pairing token rotation failed');
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
