import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import { verifyToken } from '@/lib/auth/jwt';
import { isElectronAuthBypassEnabled } from '@/lib/auth/electron-mode';
import { getElectronAuthUserId } from '@/lib/auth/electron-user';
import { SettingsManager } from '@/lib/settings/manager';
import { getSetupEntryRoute } from '@/lib/setup/setup-routing';
import { hasAnyUsers } from '@/lib/users';

export default async function HomePage() {
  if (!isElectronAuthBypassEnabled() && !(await hasAnyUsers())) {
    redirect('/setup');
  }

  const userId = await resolveEntryUserId();
  if (!userId) {
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
  const token = cookieStore.get('jwt')?.value;
  if (!token) return null;

  const payload = await verifyToken(token);
  return payload?.sub ?? null;
}
