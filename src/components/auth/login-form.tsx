'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { MessageSquare, AlertCircle } from 'lucide-react';
import { useAuthStore } from '@/stores/auth-store';
import { loginSchema } from '@/lib/validation/auth';
import { useI18n } from '@/lib/i18n';
import { Button } from '@/components/ui/button';
import { normalizeUserSettings } from '@/lib/settings/provider-defaults';
import { getSetupEntryRoute } from '@/lib/setup/setup-routing';

export function LoginForm() {
  const { t } = useI18n();
  const router = useRouter();
  const { login, isLoading, error, clearError } = useAuthStore();

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [validationError, setValidationError] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    clearError();
    setValidationError('');

    const validation = loginSchema.safeParse({ username, password });
    if (!validation.success) {
      setValidationError(validation.error.issues[0].message);
      return;
    }

    const success = await login(username, password);
    if (success) {
      try {
        const response = await fetch('/api/settings');
        if (response.ok) {
          const data = await response.json();
          const settings = normalizeUserSettings(data.settings);
          router.push(getSetupEntryRoute(settings));
          return;
        }
      } catch {
        // Fall through to setup. The setup page will retry status loading.
      }
      router.push('/setup');
    }
  };

  const displayError = validationError || error;

  return (
    <div className="min-h-screen flex items-center justify-center bg-(--chat-bg)">
      <div className="bg-(--sidebar-bg) p-8 rounded-lg shadow-2xl w-96 border border-(--divider)">
        {/* Logo */}
        <div className="flex flex-col items-center mb-8">
          <div className="w-14 h-14 rounded-2xl bg-(--accent) flex items-center justify-center mb-4">
            <MessageSquare className="w-7 h-7 text-white" />
          </div>
          <h1 className="text-2xl font-bold text-(--text-primary)">{t('auth.title')}</h1>
          <p className="text-sm text-(--text-muted) mt-1">{t('auth.subtitle')}</p>
        </div>

        {displayError && (
          <div
            role="alert"
            className="mb-4 p-3 bg-(--error)/10 border border-(--error)/30 rounded-lg flex items-center gap-2"
          >
            <AlertCircle className="w-4 h-4 text-(--error) shrink-0" />
            <span className="text-sm text-(--error)">{displayError}</span>
          </div>
        )}

        <form onSubmit={handleSubmit}>
          <div className="mb-4">
            <label htmlFor="username" className="block text-sm font-medium text-(--text-secondary) mb-2">
              {t('auth.username')}
            </label>
            <input
              type="text"
              id="username"
              name="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className="w-full px-3 py-2.5 bg-(--input-bg) border border-(--input-border) rounded-md text-(--input-text) placeholder:text-(--input-placeholder) focus:outline-none focus:ring-1 focus:ring-(--accent) focus:border-(--accent)"
              placeholder={t('auth.usernamePlaceholder')}
              disabled={isLoading}
              autoComplete="username"
            />
          </div>

          <div className="mb-6">
            <label htmlFor="password" className="block text-sm font-medium text-(--text-secondary) mb-2">
              {t('auth.password')}
            </label>
            <input
              type="password"
              id="password"
              name="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full px-3 py-2.5 bg-(--input-bg) border border-(--input-border) rounded-md text-(--input-text) placeholder:text-(--input-placeholder) focus:outline-none focus:ring-1 focus:ring-(--accent) focus:border-(--accent)"
              placeholder={t('auth.passwordPlaceholder')}
              disabled={isLoading}
              autoComplete="current-password"
            />
          </div>

          <Button
            type="submit"
            disabled={isLoading}
            className="w-full h-10"
          >
            {isLoading ? t('auth.loggingIn') : t('auth.login')}
          </Button>
        </form>

      </div>
    </div>
  );
}
