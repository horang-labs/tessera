import { NextRequest, NextResponse } from 'next/server';
import { requireAuthenticatedUserId } from '@/lib/auth/api-auth';
import {
  listDevices,
  MAX_PAIRED_DEVICES,
} from '@/lib/auth/device-registry';
import { revokeAllPairedDevices } from '@/lib/auth/device-revocation';
import { withPairedDeviceLifecycle } from '@/lib/auth/paired-device-lifecycle-lock';
import { listDevicePushSubscriptions } from '@/lib/push/device-push-subscription-store';
import { wsServer } from '@/lib/ws/server';

export async function GET(request: NextRequest) {
  const auth = await requireAuthenticatedUserId(request);
  if ('response' in auth) return auth.response;

  const { devices, subscribedDeviceIds, connectedDeviceIds } = await withPairedDeviceLifecycle(
    async () => {
      const [pairedDevices, subscriptions] = await Promise.all([
        listDevices(),
        listDevicePushSubscriptions(),
      ]);
      return {
        devices: pairedDevices,
        subscribedDeviceIds: new Set(subscriptions.map(({ deviceId }) => deviceId)),
        connectedDeviceIds: new Set(
          wsServer.listConnections()
            .map((connection) => connection.deviceId)
            .filter((deviceId): deviceId is string => Boolean(deviceId)),
        ),
      };
    },
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
