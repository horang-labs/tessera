import { NextRequest, NextResponse } from 'next/server';
import { requireAuthenticatedUserId } from '@/lib/auth/api-auth';
import {
  listDevices,
  MAX_PAIRED_DEVICES,
} from '@/lib/auth/device-registry';
import { revokeAllPairedDevices } from '@/lib/auth/device-revocation';
import { listDevicePushSubscriptions } from '@/lib/push/device-push-subscription-store';
import { wsServer } from '@/lib/ws/server';

export async function GET(request: NextRequest) {
  const auth = await requireAuthenticatedUserId(request);
  if ('response' in auth) return auth.response;

  const [devices, subscriptions] = await Promise.all([
    listDevices(),
    listDevicePushSubscriptions(),
  ]);
  const subscribedDeviceIds = new Set(
    subscriptions.map(({ deviceId }) => deviceId),
  );
  const connectedDeviceIds = new Set(
    wsServer.listConnections()
      .map((connection) => connection.deviceId)
      .filter((deviceId): deviceId is string => Boolean(deviceId)),
  );
  return NextResponse.json({
    devices: devices.map((device) => ({
      ...device,
      connected: connectedDeviceIds.has(device.id),
      hasPushSubscription: subscribedDeviceIds.has(device.id),
    })),
    maxDevices: MAX_PAIRED_DEVICES,
  });
}

export async function DELETE(request: NextRequest) {
  const auth = await requireAuthenticatedUserId(request);
  if ('response' in auth) return auth.response;

  const result = await revokeAllPairedDevices();
  return NextResponse.json({
    success: true,
    ...result,
  });
}
