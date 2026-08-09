import {
  revokeAllPairedDevices,
  type DeviceRevocationResult,
} from '@/lib/auth/device-revocation';
import { clearVapidIdentity } from '@/lib/push/vapid-identity';

export async function clearMobileAccessLocalState(): Promise<DeviceRevocationResult> {
  return revokeAllPairedDevices({ afterTrustCleared: clearVapidIdentity });
}
