import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import { verifyToken } from '@/lib/auth/jwt';
import { isElectronAuthBypassEnabled } from '@/lib/auth/electron-mode';
import { getElectronAuthUserId } from '@/lib/electron-user';
import { SettingsManager } from '@/lib/settings/manager';
import { getSetupEntryRoute } from '@/lib/setup/setup-routing';
import { findUserById, hasAnyUsers } from '@/lib/users';
import {
  DEVICE_TOKEN_COOKIE,
  resolveDeviceToken,
} from '@/lib/auth/device-registry';
import { resolveServerDefaultUserId } from '@/lib/server-default-user';

export const dynamic = 'force-dynamic';

export default async function HomePage() {
  const userId = await resolveEntryUserId();
  if (!userId) {
    if (!(await hasAnyUsers())) {
      redirect('/setup');
    }
    redirect('/login');
  }

  const settings = await SettingsManager.load(userId);
  redirect(getSetupEntryRoute(settings));
}

async function resolveEntryUserId(): Promise<string | null> {
  if (isElectronAuthBypassEnabled()) {
    return getElectronAuthUserId();
  }

  const cookieStore = await cookies();
  const deviceToken = cookieStore.get(DEVICE_TOKEN_COOKIE)?.value;
  if (deviceToken && await resolveDeviceToken(deviceToken)) {
    return (await resolveServerDefaultUserId()) ?? null;
  }

  const token = cookieStore.get('jwt')?.value;
  if (!token) return null;

  const payload = await verifyToken(token);
  if (!payload) return null;

  const user = await findUserById(payload.sub);
  return user?.id ?? null;
}
