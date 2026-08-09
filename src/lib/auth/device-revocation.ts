import { clearDeviceRegistry, revokeDevice } from './device-registry';
import { withPairedDeviceLifecycle } from './paired-device-lifecycle-lock';
import { wsServer } from '../ws/server';
import {
  clearDevicePushSubscriptions,
  deleteDevicePushSubscription,
  getDevicePushSubscription,
  listDevicePushSubscriptions,
  replaceDevicePushSubscription,
} from '../push/device-push-subscription-store';

export interface DeviceRevocationResult {
  revokedDevices: number;
  disconnectedConnections: number;
}

interface RevokeAllPairedDevicesOptions {
  afterTrustCleared?: () => Promise<void>;
}

export async function revokePairedDevice(
  deviceId: string,
): Promise<DeviceRevocationResult> {
  return withPairedDeviceLifecycle(async () => {
    const subscription = await getDevicePushSubscription(deviceId);
    await deleteDevicePushSubscription(deviceId);
    let revoked: boolean;
    try {
      revoked = await revokeDevice(deviceId);
    } catch (error) {
      if (subscription) {
        await replaceDevicePushSubscription(deviceId, subscription);
      }
      throw error;
    }
    return {
      revokedDevices: revoked ? 1 : 0,
      disconnectedConnections: revoked ? wsServer.disconnectDevice(deviceId) : 0,
    };
  });
}

export async function revokeAllPairedDevices(
  options: RevokeAllPairedDevicesOptions = {},
): Promise<DeviceRevocationResult> {
  return withPairedDeviceLifecycle(async () => {
    const subscriptions = await listDevicePushSubscriptions();
    await clearDevicePushSubscriptions();
    let revokedDeviceIds: string[];
    try {
      revokedDeviceIds = await clearDeviceRegistry();
    } catch (error) {
      await Promise.all(subscriptions.map(({ deviceId, subscription }) => (
        replaceDevicePushSubscription(deviceId, subscription)
      )));
      throw error;
    }
    await options.afterTrustCleared?.();
    let disconnectedConnections = 0;
    for (const deviceId of revokedDeviceIds) {
      disconnectedConnections += wsServer.disconnectDevice(deviceId);
    }
    return {
      revokedDevices: revokedDeviceIds.length,
      disconnectedConnections,
    };
  });
}
