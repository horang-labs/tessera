import {
  clearDeviceRegistry,
  isDeviceRegistered,
  revokeDevice,
} from './device-registry';
import { wsServer } from '../ws/server';
import {
  clearDevicePushSubscriptions,
  deleteDevicePushSubscription,
  replaceDevicePushSubscription,
  type DevicePushSubscription,
} from '../push/device-push-subscription-store';

export interface DeviceRevocationResult {
  revokedDevices: number;
  disconnectedConnections: number;
}

let lifecycleMutation = Promise.resolve();

async function mutateDeviceLifecycle<T>(operation: () => Promise<T>): Promise<T> {
  const previousMutation = lifecycleMutation;
  let releaseMutation!: () => void;
  lifecycleMutation = new Promise<void>((resolve) => { releaseMutation = resolve; });
  await previousMutation;
  try {
    return await operation();
  } finally {
    releaseMutation();
  }
}

export function replacePairedDevicePushSubscription(
  deviceId: string,
  subscription: DevicePushSubscription,
): Promise<boolean> {
  return mutateDeviceLifecycle(async () => {
    if (!isDeviceRegistered(deviceId)) return false;
    await replaceDevicePushSubscription(deviceId, subscription);
    return true;
  });
}

export function deletePairedDevicePushSubscription(deviceId: string): Promise<boolean> {
  return mutateDeviceLifecycle(() => deleteDevicePushSubscription(deviceId));
}

export async function revokePairedDevice(
  deviceId: string,
): Promise<DeviceRevocationResult> {
  return mutateDeviceLifecycle(async () => {
    await deleteDevicePushSubscription(deviceId);
    const revoked = await revokeDevice(deviceId);
    return {
      revokedDevices: revoked ? 1 : 0,
      disconnectedConnections: revoked ? wsServer.disconnectDevice(deviceId) : 0,
    };
  });
}

export async function revokeAllPairedDevices(): Promise<DeviceRevocationResult> {
  return mutateDeviceLifecycle(async () => {
    await clearDevicePushSubscriptions();
    const revokedDeviceIds = await clearDeviceRegistry();
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
