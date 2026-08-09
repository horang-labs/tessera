import { isDeviceRegistered } from './device-registry';
import { withPairedDeviceLifecycle } from './paired-device-lifecycle-lock';
import {
  deleteDevicePushSubscription,
  getDevicePushSubscription,
  listDevicePushSubscriptions,
  replaceDevicePushSubscription,
  type DevicePushSubscription,
} from '../push/device-push-subscription-store';

export function getPairedDevicePushSubscription(deviceId: string) {
  return withPairedDeviceLifecycle(() => getDevicePushSubscription(deviceId));
}

export function listPairedDevicePushSubscriptions() {
  return withPairedDeviceLifecycle(listDevicePushSubscriptions);
}

export function replacePairedDevicePushSubscription(
  deviceId: string,
  subscription: DevicePushSubscription,
): Promise<boolean> {
  return withPairedDeviceLifecycle(async () => {
    if (!isDeviceRegistered(deviceId)) return false;
    await replaceDevicePushSubscription(deviceId, subscription);
    return true;
  });
}

export function deletePairedDevicePushSubscription(
  deviceId: string,
  expectedEndpoint?: string,
): Promise<boolean> {
  return withPairedDeviceLifecycle(
    () => deleteDevicePushSubscription(deviceId, expectedEndpoint),
  );
}
