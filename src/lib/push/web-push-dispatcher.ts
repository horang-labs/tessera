import webPush from 'web-push';
import type { DevicePushSubscription } from '@/lib/auth/device-registry';
import { listDevicePushSubscriptions } from '@/lib/auth/device-registry';
import logger from '@/lib/logger';
import { SettingsManager } from '@/lib/settings/manager';
import type { ServerTransportMessage } from '@/lib/ws/message-types';
import { ensureVapidIdentity } from './vapid-identity';

const MAX_PUSH_PAYLOAD_BYTES = 2_048;
const MAX_TITLE_BYTES = 160;
const MAX_PREVIEW_BYTES = 1_200;
const COMPLETED_TITLE_FALLBACK = 'Task completed.';
const COMPLETED_PREVIEW_FALLBACK = 'Your Tessera session completed.';
const VAPID_SUBJECT = 'mailto:notifications@tessera.local';

type NotificationMessage = Extract<ServerTransportMessage, { type: 'notification' }>;
type CompletedNotificationMessage = NotificationMessage & { event: 'completed' };

export interface CompletedPushPayload {
  kind: 'completed';
  title: string;
  preview: string;
  sessionId: string;
  url: string;
}

interface PushSettingsSnapshot {
  notifications?: {
    pushEnabled?: boolean;
  };
}

interface WebPushDispatcherDependencies {
  loadSettings: (userId: string) => Promise<PushSettingsSnapshot>;
  listSubscriptions: () => Promise<DevicePushSubscription[]>;
  sendNotification: (
    subscription: DevicePushSubscription,
    payload: string,
  ) => Promise<unknown>;
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
  const suffix = '…';
  let result = '';
  for (const character of value) {
    if (Buffer.byteLength(result + character + suffix, 'utf8') > maxBytes) break;
    result += character;
  }
  return `${result}${suffix}`;
}

function notificationUrl(sessionId: string): string {
  const search = new URLSearchParams({ session: sessionId });
  return `/chat?${search}`;
}

export function buildCompletedPushPayload(
  message: CompletedNotificationMessage,
): CompletedPushPayload {
  const title = truncateUtf8(message.message.trim() || COMPLETED_TITLE_FALLBACK, MAX_TITLE_BYTES);
  let preview = truncateUtf8(
    message.preview.trim() || COMPLETED_PREVIEW_FALLBACK,
    MAX_PREVIEW_BYTES,
  );
  const payload: CompletedPushPayload = {
    kind: 'completed',
    title,
    preview,
    sessionId: message.sessionId,
    url: notificationUrl(message.sessionId),
  };

  while (Buffer.byteLength(JSON.stringify(payload), 'utf8') > MAX_PUSH_PAYLOAD_BYTES) {
    if (!preview) break;
    preview = truncateUtf8(preview.slice(0, -2), Buffer.byteLength(preview, 'utf8') - 1);
    payload.preview = preview;
  }
  return payload;
}

function isCompletedNotification(
  message: ServerTransportMessage,
): message is CompletedNotificationMessage {
  return message.type === 'notification' && message.event === 'completed';
}

export function createWebPushDispatcher(dependencies: WebPushDispatcherDependencies) {
  return function scheduleWebPush(
    userId: string,
    message: ServerTransportMessage,
  ): void {
    if (!isCompletedNotification(message)) return;

    void (async () => {
      const settings = await dependencies.loadSettings(userId);
      if (settings.notifications?.pushEnabled === false) return;

      const subscriptions = await dependencies.listSubscriptions();
      if (subscriptions.length === 0) return;
      const payload = JSON.stringify(buildCompletedPushPayload(message));

      await Promise.all(subscriptions.map(async (subscription) => {
        try {
          await dependencies.sendNotification(subscription, payload);
        } catch (error) {
          logger.warn({ error, userId, endpoint: subscription.endpoint }, 'Web Push delivery failed');
        }
      }));
    })().catch((error) => {
      logger.warn({ error, userId }, 'Web Push dispatch failed');
    });
  };
}

async function sendNotification(
  subscription: DevicePushSubscription,
  payload: string,
): Promise<void> {
  const identity = await ensureVapidIdentity();
  webPush.setVapidDetails(VAPID_SUBJECT, identity.publicKey, identity.privateKey);
  await webPush.sendNotification(subscription, payload, { TTL: 5 * 60 });
}

export const scheduleWebPushForTransportMessage = createWebPushDispatcher({
  loadSettings: (userId) => SettingsManager.load(userId, { silent: true }),
  listSubscriptions: listDevicePushSubscriptions,
  sendNotification,
});
