'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  LoaderCircle,
  RefreshCw,
  Settings2,
  Terminal,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ElectronTitlebar } from '@/components/layout/electron-titlebar';
import CliCommandOverrideSettings from '@/components/settings/cli-command-override-settings';
import { useAuthStore } from '@/stores/auth-store';
import { useSettingsStore } from '@/stores/settings-store';
import { useI18n } from '@/lib/i18n';
import { captureTelemetryOptOut } from '@/lib/telemetry/client';
import { cn } from '@/lib/utils';
import { hasHandledSetup } from '@/lib/setup/setup-routing';
import type {
  SetupEnvironmentState,
  SetupProviderState,
  SetupStatusResponse,
  SetupToolState,
  SetupToolStatus,
} from '@/lib/setup/setup-status';
import type { AgentEnvironment } from '@/lib/settings/types';

const TOOL_ORDER = ['git', 'gh'] as const;

type ToolKey = typeof TOOL_ORDER[number];
type SetupSuggestionTool = SetupStatusResponse['suggestions'][number]['tool'];
type ProviderStatus = SetupProviderState['status'];
type SetupTelemetryTrigger =
  | 'initial'
  | 'manual_refresh'
  | 'environment_switch'
  | 'command_override_saved'
  | 'account_created';

const SUPPORTED_PROVIDERS = [
  {
    providerId: 'claude-code',
    displayName: 'Claude Code',
  },
  {
    providerId: 'codex',
    displayName: 'Codex',
  },
  {
    providerId: 'opencode',
    displayName: 'OpenCode',
  },
] as const;

interface SetupClientProps {
  initialNeedsAccountSetup?: boolean | null;
}

export function SetupClient({ initialNeedsAccountSetup = null }: SetupClientProps) {
  const router = useRouter();
  const { t } = useI18n();
  const initialNeedsAccountSetupRef = useRef(initialNeedsAccountSetup);
  const checkAuth = useAuthStore((state) => state.checkAuth);
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated);
  const settings = useSettingsStore((state) => state.settings);
  const telemetryDisabledByEnv = useSettingsStore(
    (state) => state.serverHostInfo?.telemetryDisabledByEnv ?? false,
  );
  const loadSettings = useSettingsStore((state) => state.load);
  const updateSettings = useSettingsStore((state) => state.updateSettings);

  const [status, setStatus] = useState<SetupStatusResponse | null>(null);
  const [isLoading, setIsLoading] = useState(initialNeedsAccountSetup !== true);
  const [error, setError] = useState<string | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [needsAccountSetup, setNeedsAccountSetup] = useState<boolean | null>(initialNeedsAccountSetup);
  const [accountUsername, setAccountUsername] = useState('');
  const [accountPassword, setAccountPassword] = useState('');
  const [accountError, setAccountError] = useState<string | null>(null);
  const [isCreatingAccount, setIsCreatingAccount] = useState(false);
  const [switchingEnvironment, setSwitchingEnvironment] = useState<AgentEnvironment | null>(null);
  const diagnosticsRunKeysRef = useRef<Set<string>>(new Set());

  const startSetupDiagnostics = useCallback((
    trigger: SetupTelemetryTrigger,
    activeEnvironment: AgentEnvironment,
  ) => {
    if (telemetryDisabledByEnv) return;

    const runKey = `${trigger}:${activeEnvironment}`;
    if (diagnosticsRunKeysRef.current.has(runKey)) return;
    diagnosticsRunKeysRef.current.add(runKey);

    const params = new URLSearchParams({
      telemetry_source: 'setup',
      telemetry_trigger: trigger,
    });

    void fetch(`/api/diagnostics/cli?${params.toString()}`, {
      method: 'POST',
      cache: 'no-store',
    }).catch(() => {
      diagnosticsRunKeysRef.current.delete(runKey);
    });
  }, [telemetryDisabledByEnv]);

  const refreshStatus = useCallback(async (trigger: SetupTelemetryTrigger = 'manual_refresh') => {
    setIsLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({
        telemetry_source: 'setup',
        telemetry_trigger: trigger,
      });
      const response = await fetch(`/api/setup/status?${params.toString()}`);
      if (response.status === 401) {
        router.replace('/login');
        return;
      }
      if (!response.ok) {
        throw new Error('Could not check setup status.');
      }
      const nextStatus = await response.json() as SetupStatusResponse;
      setStatus(nextStatus);
      startSetupDiagnostics(trigger, nextStatus.activeEnvironment);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Could not check setup status.');
    } finally {
      setIsLoading(false);
    }
  }, [router, startSetupDiagnostics]);

  useEffect(() => {
    let cancelled = false;

    async function initialize() {
      try {
        if (initialNeedsAccountSetupRef.current === true) {
          setNeedsAccountSetup(true);
          setIsLoading(false);
          return;
        }

        const accountSetupResponse = await fetch('/api/auth/setup');
        if (cancelled) return;
        if (!accountSetupResponse.ok) {
          throw new Error('Could not check account setup status.');
        }

        const accountSetup = await accountSetupResponse.json() as { needsAccountSetup?: boolean };
        if (accountSetup.needsAccountSetup) {
          setNeedsAccountSetup(true);
          setIsLoading(false);
          return;
        }

        setNeedsAccountSetup(false);
        await checkAuth();
        if (cancelled) return;
        await loadSettings();
        if (cancelled) return;
        const loadedSettings = useSettingsStore.getState().settings;
        if (hasHandledSetup(loadedSettings)) {
          router.replace('/chat');
          setIsLoading(false);
          return;
        }
        await refreshStatus('initial');
      } catch (nextError) {
        if (cancelled) return;
        setError(nextError instanceof Error ? nextError.message : 'Could not check setup status.');
        setIsLoading(false);
      }
    }

    void initialize();
    return () => {
      cancelled = true;
    };
  }, [checkAuth, loadSettings, refreshStatus, router]);

  useEffect(() => {
    if (needsAccountSetup) return;
    if (!isAuthenticated && !isLoading) {
      router.replace('/login');
    }
  }, [isAuthenticated, isLoading, needsAccountSetup, router]);

  const environmentCopy = useMemo(() => {
    if (!status) return '';
    if (!status.isWindowsEcosystem) return t('setup.usingLocalTools');
    return status.activeEnvironment === 'wsl'
      ? t('setup.usingWslTools')
      : t('setup.usingWindowsTools');
  }, [status, t]);

  const displayedEnvironmentCopy = useMemo(() => {
    if (!switchingEnvironment) return environmentCopy;
    return switchingEnvironment === 'wsl'
      ? t('setup.switchingToWslTools')
      : t('setup.switchingToWindowsTools');
  }, [environmentCopy, switchingEnvironment, t]);

  const handleProceed = useCallback(async () => {
    const now = new Date().toISOString();
    await updateSettings({
      setup: {
        ...settings.setup,
        ...(status?.isFullyReady ? { completedAt: now } : { dismissedAt: now }),
      },
    });
    router.push('/chat');
  }, [router, settings.setup, status?.isFullyReady, updateSettings]);

  const handleCreateAccount = useCallback(async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setAccountError(null);
    setIsCreatingAccount(true);
    setIsLoading(true);

    try {
      const response = await fetch('/api/auth/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: accountUsername,
          password: accountPassword,
        }),
      });

      if (!response.ok) {
        const errorBody = await response.json().catch(() => null) as { detail?: string } | null;
        throw new Error(errorBody?.detail ?? 'Could not create account.');
      }

      setAccountUsername('');
      setAccountPassword('');
      await checkAuth();
      await loadSettings();
      await refreshStatus('account_created');
      setNeedsAccountSetup(false);
    } catch (nextError) {
      setAccountError(nextError instanceof Error ? nextError.message : 'Could not create account.');
      setIsLoading(false);
    } finally {
      setIsCreatingAccount(false);
    }
  }, [accountPassword, accountUsername, checkAuth, loadSettings, refreshStatus]);

  const switchEnvironment = useCallback(
    async (agentEnvironment: AgentEnvironment) => {
      if (switchingEnvironment || agentEnvironment === status?.activeEnvironment) {
        return;
      }

      setSwitchingEnvironment(agentEnvironment);
      setIsLoading(true);
      setError(null);
      try {
        await updateSettings({ agentEnvironment });
        await refreshStatus('environment_switch');
      } catch (nextError) {
        setError(nextError instanceof Error ? nextError.message : 'Could not change setup environment.');
        setIsLoading(false);
      } finally {
        setSwitchingEnvironment(null);
      }
    },
    [refreshStatus, status?.activeEnvironment, switchingEnvironment, updateSettings],
  );

  const handleTelemetryChange = useCallback(
    async (enabled: boolean) => {
      if (!enabled && settings.telemetry.enabled && !telemetryDisabledByEnv) {
        await captureTelemetryOptOut('setup');
      }

      await updateSettings({
        telemetry: { ...settings.telemetry, enabled },
      });
    },
    [settings.telemetry, telemetryDisabledByEnv, updateSettings],
  );

  return (
    <div className="flex min-h-screen flex-col bg-(--chat-bg) text-(--text-primary)">
      <ElectronTitlebar showMenu={false} />
      <main className="flex flex-1">
        <div className="mx-auto flex w-full max-w-4xl flex-1 flex-col px-5 py-8 sm:px-8">
        <header className="border-b border-(--divider) pb-5">
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-(--divider) bg-(--sidebar-bg)">
              <Settings2 className="h-5 w-5 text-(--accent-hover)" />
            </div>
            <div className="min-w-0">
              <h1 className="text-2xl font-semibold tracking-normal text-(--text-primary)">
                {t('setup.title')}
              </h1>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-(--text-muted)">
                {t('setup.subtitle')}
              </p>
            </div>
          </div>
        </header>

        <section className="flex-1 py-6">
          {needsAccountSetup ? (
            <AccountSetupForm
              username={accountUsername}
              password={accountPassword}
              error={accountError}
              isSubmitting={isCreatingAccount}
              onUsernameChange={setAccountUsername}
              onPasswordChange={setAccountPassword}
              onSubmit={handleCreateAccount}
            />
          ) : null}

          {isLoading && !status && !needsAccountSetup ? (
            <div className="flex items-center gap-2 text-sm text-(--text-muted)">
              <LoaderCircle className="h-4 w-4 animate-spin" />
              {t('setup.loading')}
            </div>
          ) : null}

          {error ? (
            <div className="rounded-lg border border-(--error)/30 bg-(--error)/10 px-4 py-3 text-sm text-(--error)">
              {error}
            </div>
          ) : null}

          {status && !needsAccountSetup ? (
            <div className="space-y-5" data-testid="setup-status">
              <div className="flex flex-col gap-3 rounded-lg border border-(--divider) bg-(--sidebar-bg) px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex items-center gap-2 text-sm text-(--text-secondary)">
                  <Terminal className="h-4 w-4 text-(--text-muted)" />
                  <span aria-live="polite" data-testid="setup-environment-copy">
                    {displayedEnvironmentCopy}
                  </span>
                </div>
                {status.isWindowsEcosystem ? (
                  <EnvironmentSwitch
                    activeEnvironment={status.activeEnvironment}
                    disabled={isLoading}
                    switchingEnvironment={switchingEnvironment}
                    onSwitch={switchEnvironment}
                  />
                ) : null}
              </div>

              <div className="divide-y divide-(--divider) border-y border-(--divider)">
                {getSupportedProviders(status.summary.providers).map((provider) => (
                  <ProviderRow
                    key={provider.providerId}
                    provider={provider}
                    status={status}
                  />
                ))}
                {TOOL_ORDER.map((tool) => (
                  <ToolRow
                    key={tool}
                    toolKey={tool}
                    tool={status.summary[tool]}
                    status={status}
                  />
                ))}
              </div>

              {status.suggestions.length > 0 ? (
                <div className="rounded-lg border border-[#9b7f35]/25 bg-[#9b7f35]/10 px-4 py-3 text-sm text-(--text-secondary)">
                  <p>
                    {buildSuggestionCopy(status.suggestions[0], t)}
                  </p>
                </div>
              ) : null}

              {!status.isFullyReady ? (
                <p className="text-sm leading-6 text-(--text-muted)">
                  {t('setup.limitedMode')}
                </p>
              ) : null}

              <div className="rounded-lg border border-(--divider) bg-(--sidebar-bg) px-4 py-3">
                <CliCommandOverrideSettings
                  environments={status.availableEnvironments}
                  onSaved={() => void refreshStatus('command_override_saved')}
                />
              </div>

              <SetupTelemetryConsent
                enabled={settings.telemetry.enabled && !telemetryDisabledByEnv}
                disabled={telemetryDisabledByEnv}
                onChange={handleTelemetryChange}
              />

              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  onClick={handleProceed}
                  data-testid="setup-continue"
                >
                  {status.isFullyReady ? t('setup.start') : t('setup.continue')}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => void refreshStatus('manual_refresh')}
                  disabled={isLoading}
                >
                  <RefreshCw className={cn('h-4 w-4', isLoading && 'animate-spin')} />
                  {t('setup.checkAgain')}
                </Button>
              </div>

              <div className="pt-2">
                <button
                  type="button"
                  onClick={() => setShowAdvanced((value) => !value)}
                  data-testid="setup-advanced-toggle"
                  className="inline-flex items-center gap-1.5 text-xs font-medium text-(--text-muted) hover:text-(--text-primary)"
                >
                  {showAdvanced ? (
                    <ChevronUp className="h-3.5 w-3.5" />
                  ) : (
                    <ChevronDown className="h-3.5 w-3.5" />
                  )}
                  {showAdvanced ? t('setup.hideAdvanced') : t('setup.showAdvanced')}
                </button>
                {showAdvanced ? <AdvancedDetails status={status} /> : null}
              </div>
            </div>
          ) : null}
        </section>
        </div>
      </main>
    </div>
  );
}

function SetupTelemetryConsent({
  enabled,
  disabled,
  onChange,
}: {
  enabled: boolean;
  disabled: boolean;
  onChange: (enabled: boolean) => void;
}) {
  const { t } = useI18n();

  return (
    <div
      className="rounded-lg border border-(--divider) bg-(--sidebar-bg) px-4 py-3"
      data-testid="setup-telemetry-consent"
    >
      <label
        htmlFor="setup-telemetry-enabled"
        className="flex cursor-pointer items-start gap-3"
      >
        <input
          type="checkbox"
          id="setup-telemetry-enabled"
          checked={enabled}
          disabled={disabled}
          onChange={(event) => onChange(event.target.checked)}
          className="mt-1 h-4 w-4 accent-(--accent) disabled:cursor-not-allowed disabled:opacity-60"
        />
        <span className="min-w-0">
          <span className="block text-sm font-medium text-(--text-primary)">
            {t('setup.telemetryTitle')}
          </span>
          <span className="mt-1 block text-xs leading-5 text-(--text-muted)">
            {t('setup.telemetryDescription')}
          </span>
          {disabled ? (
            <span className="mt-2 block text-xs leading-5 text-(--text-muted)">
              {t('settings.telemetry.disabledByEnv')}
            </span>
          ) : null}
        </span>
      </label>
    </div>
  );
}

function EnvironmentSwitch({
  activeEnvironment,
  disabled,
  switchingEnvironment,
  onSwitch,
}: {
  activeEnvironment: AgentEnvironment;
  disabled: boolean;
  switchingEnvironment: AgentEnvironment | null;
  onSwitch: (environment: AgentEnvironment) => void;
}) {
  const { t } = useI18n();
  const target = switchingEnvironment ?? (activeEnvironment === 'native' ? 'wsl' : 'native');
  const isSwitching = switchingEnvironment !== null;
  const label = getEnvironmentSwitchLabel(target, isSwitching, t);

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      disabled={disabled}
      aria-busy={isSwitching}
      onClick={() => onSwitch(target)}
      data-testid="setup-environment-switch"
      className="min-w-[10.5rem] justify-center"
    >
      {isSwitching ? <LoaderCircle className="h-4 w-4 animate-spin" /> : null}
      {label}
    </Button>
  );
}

function getEnvironmentSwitchLabel(
  target: AgentEnvironment,
  isSwitching: boolean,
  t: ReturnType<typeof useI18n>['t'],
): string {
  if (isSwitching) {
    if (target === 'native') {
      return t('setup.switchingToWindowsTools');
    }
    return t('setup.switchingToWslTools');
  }

  if (target === 'native') {
    return t('setup.useWindowsTools');
  }
  return t('setup.useWslTools');
}

function AccountSetupForm({
  username,
  password,
  error,
  isSubmitting,
  onUsernameChange,
  onPasswordChange,
  onSubmit,
}: {
  username: string;
  password: string;
  error: string | null;
  isSubmitting: boolean;
  onUsernameChange: (value: string) => void;
  onPasswordChange: (value: string) => void;
  onSubmit: (event: React.FormEvent<HTMLFormElement>) => void;
}) {
  const { t } = useI18n();

  return (
    <form
      onSubmit={onSubmit}
      className="space-y-4 rounded-lg border border-(--divider) bg-(--sidebar-bg) px-4 py-4"
      data-testid="setup-account-form"
    >
      <div>
        <h2 className="text-sm font-semibold text-(--text-primary)">
          {t('setup.accountTitle')}
        </h2>
        <p className="mt-1 text-sm leading-6 text-(--text-muted)">
          {t('setup.accountSubtitle')}
        </p>
      </div>

      {error ? (
        <div
          role="alert"
          className="rounded-md border border-(--error)/30 bg-(--error)/10 px-3 py-2 text-sm text-(--error)"
        >
          {error}
        </div>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="text-xs font-medium text-(--text-secondary)">
            {t('auth.username')}
          </span>
          <input
            name="username"
            value={username}
            onChange={(event) => onUsernameChange(event.target.value)}
            placeholder={t('auth.usernamePlaceholder')}
            autoComplete="username"
            disabled={isSubmitting}
            className="mt-1 h-10 w-full rounded-md border border-(--input-border) bg-(--input-bg) px-3 text-sm text-(--input-text) outline-none focus:border-(--accent)"
          />
        </label>
        <label className="block">
          <span className="text-xs font-medium text-(--text-secondary)">
            {t('auth.password')}
          </span>
          <input
            name="password"
            type="password"
            value={password}
            onChange={(event) => onPasswordChange(event.target.value)}
            placeholder={t('auth.passwordPlaceholder')}
            autoComplete="new-password"
            disabled={isSubmitting}
            className="mt-1 h-10 w-full rounded-md border border-(--input-border) bg-(--input-bg) px-3 text-sm text-(--input-text) outline-none focus:border-(--accent)"
          />
        </label>
      </div>

      <Button type="submit" disabled={isSubmitting}>
        {isSubmitting ? t('setup.creatingAccount') : t('setup.createAccount')}
      </Button>
    </form>
  );
}

function ToolRow({
  toolKey,
  tool,
  status,
}: {
  toolKey: ToolKey;
  tool: SetupToolState;
  status: SetupStatusResponse;
}) {
  const { t } = useI18n();
  const label = getToolLabel(toolKey, t);

  return (
    <div className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <StatusIcon status={tool.status} />
          <h2 className="text-sm font-semibold text-(--text-primary)">{label}</h2>
          <span className={cn('rounded-full px-2 py-0.5 text-[11px] font-medium', statusClass(tool.status))}>
            {getStatusLabel(tool.status, t)}
          </span>
        </div>
        <p className="mt-1 text-sm leading-6 text-(--text-muted)">
          {tool.message}
        </p>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        {tool.installUrl ? (
          <InstallLink
            href={tool.installUrl}
            label={status.isWindowsEcosystem ? t('setup.installForWindows') : t('setup.install')}
          />
        ) : null}
        {tool.loginCommand ? (
          <code className="rounded-md border border-(--divider) bg-(--input-bg) px-2 py-1 text-xs text-(--text-secondary)">
            {tool.loginCommand}
          </code>
        ) : null}
      </div>
    </div>
  );
}

function ProviderRow({
  provider,
  status,
}: {
  provider: SetupProviderState;
  status: SetupStatusResponse;
}) {
  const { t } = useI18n();
  const installUrl = getProviderInstallUrl(provider.providerId, status);

  return (
    <div
      className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center sm:justify-between"
      data-testid={`setup-provider-${provider.providerId}`}
    >
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <ProviderStatusIcon status={provider.status} />
          <h2 className="text-sm font-semibold text-(--text-primary)">
            {provider.displayName}
          </h2>
          <span className={cn('rounded-full px-2 py-0.5 text-[11px] font-medium', providerStatusClass(provider.status))}>
            {getProviderStatusLabel(provider.status, t)}
          </span>
        </div>
        <p className="mt-1 text-sm leading-6 text-(--text-muted)">
          {getProviderStatusMessage(provider.status, t)}
          {provider.version ? (
            <span className="ml-2 font-mono text-xs text-(--text-secondary)">
              {provider.version}
            </span>
          ) : null}
        </p>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        {provider.status === 'not_installed' && installUrl ? (
          <InstallLink href={installUrl} label={t('setup.install')} />
        ) : null}
      </div>
    </div>
  );
}

function AdvancedDetails({ status }: { status: SetupStatusResponse }) {
  const { t } = useI18n();
  return (
    <div
      className="mt-3 rounded-lg border border-(--divider) bg-(--sidebar-bg) p-3"
      data-testid="setup-advanced-details"
    >
      <p className="mb-3 text-xs font-semibold uppercase tracking-[0.08em] text-(--text-muted)">
        {t('setup.advancedTitle')}
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        {status.availableEnvironments.map((environment) => {
          const entry = status.environments[environment];
          if (!entry) return null;
          return (
            <EnvironmentDetail
              key={environment}
              title={
                environment === 'native'
                  ? status.isWindowsEcosystem
                    ? t('setup.windowsTools')
                    : t('setup.usingLocalTools')
                  : t('setup.wslTools')
              }
              state={entry}
            />
          );
        })}
      </div>
    </div>
  );
}

function EnvironmentDetail({
  title,
  state,
}: {
  title: string;
  state: SetupEnvironmentState;
}) {
  const { t } = useI18n();
  return (
    <div className="rounded-md border border-(--divider) bg-(--chat-bg) p-3">
      <p className="text-sm font-semibold text-(--text-primary)">{title}</p>
      <div className="mt-3 space-y-2 text-xs">
        {getSupportedProviders(state.providers).map((provider) => (
          <div key={provider.providerId} className="flex items-center justify-between gap-2">
            <span className="text-(--text-muted)">{provider.displayName}</span>
            <span className={cn('font-medium', providerInlineStatusClass(provider.status))}>
              {getProviderStatusLabel(provider.status, t)}
            </span>
          </div>
        ))}
        {TOOL_ORDER.map((tool) => (
          <div key={tool} className="flex items-center justify-between gap-2">
            <span className="text-(--text-muted)">{getToolLabel(tool, t)}</span>
            <span className={cn('font-medium', inlineStatusClass(state[tool].status))}>
              {getStatusLabel(state[tool].status, t)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function InstallLink({ href, label }: { href: string; label: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="inline-flex h-8 items-center justify-center gap-1.5 rounded-md border border-(--input-border) px-3 text-xs font-medium text-(--text-secondary) transition-colors hover:bg-(--sidebar-hover) hover:text-(--text-primary)"
    >
      {label}
      <ExternalLink className="h-3 w-3" />
    </a>
  );
}

function StatusIcon({ status }: { status: SetupToolStatus }) {
  if (status === 'ready') {
    return <CheckCircle2 className="h-4 w-4 text-[#2f8753]" />;
  }
  return <AlertCircle className="h-4 w-4 text-[#9b7f35]" />;
}

function ProviderStatusIcon({ status }: { status: ProviderStatus }) {
  if (status === 'connected') {
    return <CheckCircle2 className="h-4 w-4 text-[#2f8753]" />;
  }
  return <AlertCircle className="h-4 w-4 text-[#9b7f35]" />;
}

function getSupportedProviders(providers: SetupProviderState[]): SetupProviderState[] {
  const byId = new Map(providers.map((provider) => [provider.providerId, provider]));
  return SUPPORTED_PROVIDERS.map((provider) => {
    const existing = byId.get(provider.providerId);
    return existing
      ? { ...existing, displayName: provider.displayName }
      : {
        providerId: provider.providerId,
        displayName: provider.displayName,
        status: 'not_installed',
      };
  });
}

function getProviderInstallUrl(providerId: string, status: SetupStatusResponse): string | null {
  if (providerId === 'claude-code') return status.installLinks.claudeCode;
  if (providerId === 'codex') return status.installLinks.codex;
  if (providerId === 'opencode') return status.installLinks.opencode;
  return null;
}

function getToolLabel(tool: ToolKey | SetupSuggestionTool, t: (key: string) => string): string {
  if (tool === 'aiCli') return t('setup.aiCli');
  if (tool === 'git') return t('setup.git');
  return t('setup.gh');
}

function getProviderStatusLabel(status: ProviderStatus, t: (key: string) => string): string {
  switch (status) {
    case 'connected':
      return t('setup.ready');
    case 'needs_login':
      return t('setup.needsLogin');
    default:
      return t('setup.missing');
  }
}

function getProviderStatusMessage(status: ProviderStatus, t: (key: string) => string): string {
  switch (status) {
    case 'connected':
      return t('setup.providerReady');
    case 'needs_login':
      return t('setup.providerNeedsLogin');
    default:
      return t('setup.providerMissing');
  }
}

function getStatusLabel(status: SetupToolStatus, t: (key: string) => string): string {
  switch (status) {
    case 'ready':
      return t('setup.ready');
    case 'needs_login':
      return t('setup.needsLogin');
    case 'needs_config':
      return t('setup.needsConfig');
    default:
      return t('setup.missing');
  }
}

function providerStatusClass(status: ProviderStatus): string {
  if (status === 'connected') {
    return 'bg-[#2f8753]/10 text-[#2f8753]';
  }
  if (status === 'not_installed') {
    return 'bg-[#c94c4c]/10 text-[#c94c4c]';
  }
  return 'bg-[#9b7f35]/10 text-[#9b7f35]';
}

function statusClass(status: SetupToolStatus): string {
  if (status === 'ready') {
    return 'bg-[#2f8753]/10 text-[#2f8753]';
  }
  if (status === 'missing') {
    return 'bg-[#c94c4c]/10 text-[#c94c4c]';
  }
  return 'bg-[#9b7f35]/10 text-[#9b7f35]';
}

function providerInlineStatusClass(status: ProviderStatus): string {
  if (status === 'connected') return 'text-[#2f8753]';
  if (status === 'not_installed') return 'text-[#c94c4c]';
  return 'text-[#9b7f35]';
}

function inlineStatusClass(status: SetupToolStatus): string {
  if (status === 'ready') return 'text-[#2f8753]';
  if (status === 'missing') return 'text-[#c94c4c]';
  return 'text-[#9b7f35]';
}

function buildSuggestionCopy(
  suggestion: SetupStatusResponse['suggestions'][number],
  t: (key: string) => string,
): string {
  const toolName = getToolLabel(suggestion.tool, t);
  const target = suggestion.availableEnvironment === 'native'
    ? t('setup.windowsTools')
    : t('setup.wslTools');
  return `${toolName} is ready in ${target}. You can switch tools or install it where Tessera is currently looking.`;
}
