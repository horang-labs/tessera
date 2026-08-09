import { isInstalledPwa } from '@/lib/pwa/install-guidance';

export function supportsInstalledPwaPush(): boolean {
  return typeof window !== 'undefined'
    && window.isSecureContext
    && isInstalledPwa()
    && 'Notification' in window
    && 'serviceWorker' in navigator
    && 'PushManager' in window;
}

export function vapidPublicKeyBytes(publicKey: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (publicKey.length % 4)) % 4);
  const base64 = (publicKey + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = window.atob(base64);
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let index = 0; index < raw.length; index += 1) {
    bytes[index] = raw.charCodeAt(index);
  }
  return bytes;
}

export async function requestPushPermission(): Promise<NotificationPermission> {
  return Notification.requestPermission();
}
