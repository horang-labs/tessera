import { isDeviceRegistered } from './device-registry';
import { withPairedDeviceLifecycle } from './paired-device-lifecycle-lock';
import {
  deleteDevicePushSubscription,
  getDevicePushSubscription,
  listDevicePushSubscriptions,
  replaceDevicePushSubscription,
  type DevicePushSubscription,
} from '../push/device-push-subscription-store';
import { ensureVapidIdentity, type VapidIdentity } from '../push/vapid-identity';

export interface PairedDevicePushConfiguration {
  identity: VapidIdentity;
  subscription: DevicePushSubscription | null;
}

export function getPairedDevicePushConfiguration(
  deviceId: string,
): Promise<PairedDevicePushConfiguration | null> {
  return withPairedDeviceLifecycle(async () => {
    if (!isDeviceRegistered(deviceId)) return null;
    const [identity, subscription] = await Promise.all([
      ensureVapidIdentity(),
      getDevicePushSubscription(deviceId),
    ]);
    return { identity, subscription };
  });
}

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
