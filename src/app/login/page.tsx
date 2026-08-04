import { LoginForm } from '@/components/auth/login-form';
import { redirect } from 'next/navigation';
import { isElectronRuntime } from '@/lib/electron-runtime';
import { hasAnyUsers } from '@/lib/users';

export const dynamic = 'force-dynamic';

export default async function LoginPage() {
  if (isElectronRuntime()) {
    redirect('/');
  }

  if (!(await hasAnyUsers())) {
    redirect('/setup');
  }

  return <LoginForm />;
}
