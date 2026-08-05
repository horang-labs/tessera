import { NextRequest, NextResponse } from 'next/server';
import { requireAuthenticatedUserId } from '@/lib/auth/api-auth';
import { revokePairedDevice } from '@/lib/auth/device-revocation';

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAuthenticatedUserId(request);
  if ('response' in auth) return auth.response;

  const { id } = await params;
  const result = await revokePairedDevice(id);
  if (result.revokedDevices === 0) {
    return NextResponse.json(
      { error: 'Device not found', code: 'device-not-found' },
      { status: 404 },
    );
  }
  return NextResponse.json({
    success: true,
    disconnectedConnections: result.disconnectedConnections,
  });
}
