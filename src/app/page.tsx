import { redirect } from 'next/navigation';
import { cookies, headers } from 'next/headers';
import { requestGateInputFromServerContext } from '@/lib/auth/next-request-gate';
import { evaluateRequestAndLog } from '@/lib/auth/request-gate';
import { SettingsManager } from '@/lib/settings/manager';
import { getSetupEntryRoute } from '@/lib/setup/setup-routing';
import { hasAnyUsers } from '@/lib/users';

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
  const [requestHeaders, requestCookies] = await Promise.all([headers(), cookies()]);
  const decision = await evaluateRequestAndLog(requestGateInputFromServerContext({
    headers: requestHeaders,
    cookies: requestCookies,
    method: 'GET',
    rawUrl: '/',
  }));
  return decision.allow ? decision.userId : null;
}
