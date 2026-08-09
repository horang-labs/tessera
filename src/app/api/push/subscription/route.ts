import { NextRequest, NextResponse } from 'next/server';
import { requireAuthenticatedUserId } from '@/lib/auth/api-auth';
import {
  deletePairedDevicePushSubscription,
  getPairedDevicePushSubscription,
  replacePairedDevicePushSubscription,
} from '@/lib/auth/paired-device-lifecycle';
import {
  isDevicePushSubscription,
} from '@/lib/push/device-push-subscription-store';
import { ensureVapidIdentity } from '@/lib/push/vapid-identity';

async function requirePairedDevice(request: NextRequest) {
  const auth = await requireAuthenticatedUserId(request);
  if ('response' in auth) return auth;
  if (auth.kind !== 'device' || !auth.deviceId) {
    return {
      response: NextResponse.json(
        { error: 'A paired device is required' },
        { status: 403 },
      ),
    };
  }
  return { deviceId: auth.deviceId };
}

export async function GET(request: NextRequest) {
  const auth = await requirePairedDevice(request);
  if ('response' in auth) return auth.response;

  const [identity, subscription] = await Promise.all([
    ensureVapidIdentity(),
    getPairedDevicePushSubscription(auth.deviceId),
  ]);
  return NextResponse.json({
    vapidPublicKey: identity.publicKey,
    subscription,
  });
}

export async function PUT(request: NextRequest) {
  const auth = await requirePairedDevice(request);
  if ('response' in auth) return auth.response;

  const subscription = await request.json().catch(() => null);
  if (!isDevicePushSubscription(subscription)) {
    return NextResponse.json({ error: 'Invalid Push subscription' }, { status: 400 });
  }

  const replaced = await replacePairedDevicePushSubscription(auth.deviceId, subscription);
  return replaced
    ? NextResponse.json({ success: true, subscription })
    : NextResponse.json({ error: 'Paired device not found' }, { status: 404 });
}

export async function DELETE(request: NextRequest) {
  const auth = await requirePairedDevice(request);
  if ('response' in auth) return auth.response;

  await deletePairedDevicePushSubscription(auth.deviceId);
  return NextResponse.json({ success: true });
}
