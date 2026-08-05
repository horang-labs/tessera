import { SetupClient } from '@/components/setup/setup-client';
import { isElectronRuntime } from '@/lib/electron-runtime';
import { hasAnyUsers } from '@/lib/users';

export const dynamic = 'force-dynamic';

export default async function SetupPage() {
  const initialNeedsAccountSetup =
    !isElectronRuntime() && !(await hasAnyUsers()) ? true : null;

  return <SetupClient initialNeedsAccountSetup={initialNeedsAccountSetup} />;
}
