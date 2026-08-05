import { clearDeviceRegistry, revokeDevice } from './device-registry';
import { wsServer } from '../ws/server';

export interface DeviceRevocationResult {
  revokedDevices: number;
  disconnectedConnections: number;
}

export async function revokePairedDevice(
  deviceId: string,
): Promise<DeviceRevocationResult> {
  const revoked = await revokeDevice(deviceId);
  return {
    revokedDevices: revoked ? 1 : 0,
    disconnectedConnections: revoked ? wsServer.disconnectDevice(deviceId) : 0,
  };
}

export async function revokeAllPairedDevices(): Promise<DeviceRevocationResult> {
  const revokedDeviceIds = await clearDeviceRegistry();
  let disconnectedConnections = 0;
  for (const deviceId of revokedDeviceIds) {
    disconnectedConnections += wsServer.disconnectDevice(deviceId);
  }
  return {
    revokedDevices: revokedDeviceIds.length,
    disconnectedConnections,
  };
}
