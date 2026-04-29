import { LoginForm } from '@/components/auth/login-form';
import { redirect } from 'next/navigation';
import { isElectronAuthBypassEnabled } from '@/lib/auth/electron-mode';

export default function LoginPage() {
  if (isElectronAuthBypassEnabled()) {
    redirect('/');
  }

  return <LoginForm />;
}
