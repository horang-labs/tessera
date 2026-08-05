'use client';

import { useEffect, useState } from 'react';
import {
  AlertTriangle,
  Check,
  Copy,
  Link2,
  QrCode,
  RadioTower,
  RefreshCw,
  ShieldCheck,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { normalizeAdvertisedAddress } from '@/lib/auth/advertised-address';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { useNotificationStore } from '@/stores/notification-store';
import PairedDeviceManagement from './paired-device-management';

interface PairingPresentation {
  pairingLink: string;
  createdAt: string;
  expiresAt: string;
  qrDataUrl?: string;
}

interface PairingErrorBody {
  code?: unknown;
  error?: unknown;
}

type ElectronPairingResult =
  | ({ ok: true } & PairingPresentation & { qrDataUrl: string })
  | { ok: false; code: string; error: string };

type ElectronFirewallResult =
  | { ok: true }
  | { ok: false; code: string; error: string };

interface RemoteAccessAddressCandidate {
  interfaceName: string;
  address: string;
  isTailscale: boolean;
  url: string;
}

type ElectronPairingApi = {
  isElectron?: boolean;
  platform?: string;
  supportsTailscaleFirewallConfiguration?: boolean;
  getRemoteAccessAddressCandidates?: () => Promise<RemoteAccessAddressCandidate[]>;
  createPairingCode?: (action: 'issue' | 'rotate') => Promise<ElectronPairingResult>;
  configureTailscaleFirewall?: () => Promise<ElectronFirewallResult>;
};

function getElectronPairingApi(): ElectronPairingApi | undefined {
  if (typeof window === 'undefined') return undefined;
  return (window as Window & { electronAPI?: ElectronPairingApi }).electronAPI;
}

function normalizeAddressCandidate(value: string): string | null {
  return normalizeAdvertisedAddress(value)?.origin ?? null;
}

function isRemoteAccessAddressCandidate(
  value: unknown,
): value is RemoteAccessAddressCandidate {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<RemoteAccessAddressCandidate>;
  return (
    typeof candidate.interfaceName === 'string'
    && typeof candidate.address === 'string'
    && typeof candidate.isTailscale === 'boolean'
    && typeof candidate.url === 'string'
  );
}

async function pairingRequest(action: 'issue' | 'rotate'): Promise<PairingPresentation> {
  const electronApi = getElectronPairingApi();
  if (electronApi?.isElectron && electronApi.createPairingCode) {
    const result = await electronApi.createPairingCode(action);
    if (result.ok) return result;
    const error = new Error(result.error) as Error & { code?: string };
    error.code = result.code;
    throw error;
  }

  const response = await fetch('/api/pairing', {
    method: action === 'rotate' ? 'PUT' : 'POST',
    headers: { 'Content-Type': 'application/json' },
  });
  const body = await response.json().catch(() => null) as (
    PairingPresentation & PairingErrorBody
  ) | null;
  if (
    response.ok
    && typeof body?.pairingLink === 'string'
    && typeof body.createdAt === 'string'
    && typeof body.expiresAt === 'string'
  ) {
    return body;
  }

  const error = new Error(
    typeof body?.error === 'string' ? body.error : 'Pairing failed',
  ) as Error & { code?: string };
  error.code = typeof body?.code === 'string' ? body.code : 'pairing-failed';
  throw error;
}

function formatRemaining(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.ceil(milliseconds / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = String(totalSeconds % 60).padStart(2, '0');
  return `${minutes}:${seconds}`;
}

export default function RemoteAccessSection() {
  const { t } = useI18n();
  const showToast = useNotificationStore((state) => state.showToast);
  const [address, setAddress] = useState('');
  const [addressCandidates, setAddressCandidates] = useState<RemoteAccessAddressCandidate[]>([]);
  const [savedAddress, setSavedAddress] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [isPairing, setIsPairing] = useState(false);
  const [isConfiguringFirewall, setIsConfiguringFirewall] = useState(false);
  const [addressError, setAddressError] = useState<string | null>(null);
  const [pairingError, setPairingError] = useState<string | null>(null);
  const [firewallError, setFirewallError] = useState<string | null>(null);
  const [presentation, setPresentation] = useState<PairingPresentation | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(function loadRemoteAccessSettings() {
    let cancelled = false;
    const electronApi = getElectronPairingApi();
    const addressCandidatesPromise = electronApi?.isElectron
      && electronApi.getRemoteAccessAddressCandidates
      ? electronApi.getRemoteAccessAddressCandidates().catch(() => [])
      : Promise.resolve([]);

    void Promise.all([
      fetch('/api/settings').then(async (response) => {
        if (!response.ok) throw new Error('load-failed');
        return response.json() as Promise<{
          machineSettings?: { advertisedAddress?: unknown };
        }>;
      }),
      addressCandidatesPromise,
    ])
      .then(([body, rawAddressCandidates]) => {
        const addressCandidates = Array.isArray(rawAddressCandidates)
          ? rawAddressCandidates.filter(isRemoteAccessAddressCandidate)
          : [];
        const advertisedAddress = typeof body.machineSettings?.advertisedAddress === 'string'
          ? body.machineSettings.advertisedAddress
          : null;
        if (!cancelled) {
          setAddressCandidates(addressCandidates);
          setAddress(advertisedAddress ?? addressCandidates[0]?.url ?? '');
          setSavedAddress(advertisedAddress);
          setIsLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setAddressError(t('settings.remoteAccess.loadFailed'));
          setIsLoading(false);
        }
      });
    return function ignoreRemoteSettingsAfterUnmount() {
      cancelled = true;
    };
  }, [t]);

  useEffect(function tickPairingExpiry() {
    if (!presentation) return;
    setNow(Date.now());
    const interval = window.setInterval(() => setNow(Date.now()), 1_000);
    return function stopPairingExpiryClock() {
      window.clearInterval(interval);
    };
  }, [presentation]);

  const normalizedDraft = (() => {
    try {
      return normalizeAddressCandidate(address);
    } catch {
      return undefined;
    }
  })();
  const isSavedAddressCurrent = normalizedDraft !== undefined && normalizedDraft === savedAddress;
  const canAddDevice = Boolean(savedAddress && isSavedAddressCurrent && !isSaving && !isLoading);
  const remainingMs = presentation ? Date.parse(presentation.expiresAt) - now : 0;
  const isExpired = Boolean(presentation && remainingMs <= 0);
  const electronApi = getElectronPairingApi();
  const canConfigureWindowsFirewall = Boolean(
    electronApi?.isElectron
    && electronApi.platform === 'win32'
    && electronApi.supportsTailscaleFirewallConfiguration
    && electronApi.configureTailscaleFirewall,
  );
  const showsSystemFirewallGuidance = Boolean(
    electronApi?.isElectron
    && (electronApi.platform === 'darwin' || electronApi.platform === 'linux'),
  );

  const handleConfigureFirewall = async () => {
    if (!electronApi?.configureTailscaleFirewall) return;
    setIsConfiguringFirewall(true);
    setFirewallError(null);
    try {
      const result = await electronApi.configureTailscaleFirewall();
      if (result.ok) {
        showToast(t('settings.remoteAccess.firewallConfigured'), 'success');
        return;
      }
      if (result.code === 'cancelled') {
        setFirewallError(t('settings.remoteAccess.firewallCancelled'));
      } else if (result.code === 'tailscale-not-found') {
        setFirewallError(t('settings.remoteAccess.firewallTailscaleNotFound'));
      } else {
        setFirewallError(t('settings.remoteAccess.firewallFailed'));
      }
    } catch {
      setFirewallError(t('settings.remoteAccess.firewallFailed'));
    } finally {
      setIsConfiguringFirewall(false);
    }
  };

  const handleSaveAddress = async () => {
    let normalizedAddress: string | null;
    try {
      normalizedAddress = normalizeAddressCandidate(address);
    } catch {
      setAddressError(t('settings.remoteAccess.invalidAddress'));
      return;
    }

    setIsSaving(true);
    setAddressError(null);
    setPairingError(null);
    try {
      const response = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          machineSettings: { advertisedAddress: normalizedAddress },
        }),
      });
      const body = await response.json().catch(() => null) as {
        code?: unknown;
        error?: unknown;
        machineSettings?: { advertisedAddress?: unknown };
      } | null;
      if (!response.ok) {
        throw new Error(
          body?.code === 'invalid_advertised_address'
            ? 'invalid-address'
            : 'save-failed',
        );
      }
      const persistedAddress = typeof body?.machineSettings?.advertisedAddress === 'string'
        ? body.machineSettings.advertisedAddress
        : null;
      setAddress(persistedAddress ?? '');
      setSavedAddress(persistedAddress);
      setPresentation(null);
    } catch (error) {
      setAddressError(
        error instanceof Error && error.message === 'invalid-address'
          ? t('settings.remoteAccess.invalidAddress')
          : t('settings.remoteAccess.saveFailed'),
      );
    } finally {
      setIsSaving(false);
    }
  };

  const handlePairing = async (action: 'issue' | 'rotate') => {
    setIsPairing(true);
    setPairingError(null);
    try {
      let nextPresentation: PairingPresentation;
      try {
        nextPresentation = await pairingRequest(action);
      } catch (error) {
        if (
          action === 'issue'
          && error instanceof Error
          && 'code' in error
          && error.code === 'pairing-active'
        ) {
          nextPresentation = await pairingRequest('rotate');
        } else {
          throw error;
        }
      }
      setPresentation(nextPresentation);
      setNow(Date.now());
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? String(error.code) : '';
      setPairingError(
        code === 'capacity-reached'
          ? t('settings.remoteAccess.capacityReached')
          : t('settings.remoteAccess.pairingFailed'),
      );
    } finally {
      setIsPairing(false);
    }
  };

  const handleCopyLink = async () => {
    if (!presentation) return;
    try {
      await navigator.clipboard.writeText(presentation.pairingLink);
      showToast(t('settings.remoteAccess.linkCopied'), 'success');
    } catch {
      showToast(presentation.pairingLink, 'warning');
    }
  };

  return (
    <div className="space-y-5">
      <div>
        <h3 className="font-medium text-(--text-primary)">
          {t('settings.remoteAccess.title')}
        </h3>
        <p className="mt-1 text-sm leading-5 text-(--text-secondary)">
          {t('settings.remoteAccess.description')}
        </p>
      </div>

      <div className="flex items-start gap-3 rounded-lg border border-(--status-warning-border) bg-(--status-warning-bg) p-3 text-(--status-warning-text)">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
        <div className="min-w-0">
          <p className="text-sm font-medium">{t('settings.remoteAccess.warningTitle')}</p>
          <p className="mt-1 text-xs leading-5 opacity-90">
            {t('settings.remoteAccess.warningDescription')}
          </p>
        </div>
      </div>

      {canConfigureWindowsFirewall ? (
        <div className="flex flex-col gap-3 rounded-lg border border-(--divider) bg-(--input-bg) p-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <p className="flex items-center gap-2 text-sm font-medium text-(--text-primary)">
              <ShieldCheck className="h-4 w-4 text-(--accent)" />
              {t('settings.remoteAccess.firewallTitle')}
            </p>
            <p className="mt-1 text-xs leading-5 text-(--text-muted)">
              {t('settings.remoteAccess.firewallDescription')}
            </p>
            {firewallError ? (
              <p className="mt-2 text-xs text-(--status-error-text)">{firewallError}</p>
            ) : null}
          </div>
          <Button
            type="button"
            variant="outline"
            onClick={() => void handleConfigureFirewall()}
            disabled={isConfiguringFirewall}
            className="shrink-0"
          >
            {isConfiguringFirewall
              ? <RefreshCw className="h-4 w-4 animate-spin" />
              : <ShieldCheck className="h-4 w-4" />}
            {isConfiguringFirewall
              ? t('settings.remoteAccess.firewallConfiguring')
              : t('settings.remoteAccess.firewallConfigure')}
          </Button>
        </div>
      ) : null}

      {showsSystemFirewallGuidance ? (
        <div className="flex items-start gap-3 rounded-lg border border-(--divider) bg-(--input-bg) p-3">
          <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-(--accent)" />
          <div className="min-w-0">
            <p className="text-sm font-medium text-(--text-primary)">
              {t('settings.remoteAccess.systemFirewallTitle')}
            </p>
            <p className="mt-1 text-xs leading-5 text-(--text-muted)">
              {t('settings.remoteAccess.systemFirewallDescription')}
            </p>
          </div>
        </div>
      ) : null}

      <div className="space-y-2">
        <label htmlFor="advertised-address" className="text-sm font-medium text-(--text-secondary)">
          {t('settings.remoteAccess.addressLabel')}
        </label>
        {addressCandidates.length > 0 ? (
          <div className="rounded-lg border border-(--divider) bg-(--input-bg) p-3">
            <p className="flex items-center gap-2 text-xs font-medium text-(--text-primary)">
              <RadioTower className="h-3.5 w-3.5 text-(--accent)" />
              {t('settings.remoteAccess.detectedAddressTitle')}
            </p>
            <p className="mt-1 text-xs leading-5 text-(--text-muted)">
              {t('settings.remoteAccess.detectedAddressDescription')}
            </p>
            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              {addressCandidates.map((candidate) => {
                const isSelected = normalizedDraft === candidate.url;
                return (
                  <button
                    key={`${candidate.interfaceName}:${candidate.address}`}
                    type="button"
                    onClick={() => {
                      setAddress(candidate.url);
                      setAddressError(null);
                    }}
                    disabled={isLoading || isSaving}
                    aria-pressed={isSelected}
                    className={cn(
                      'min-w-0 rounded-md border px-3 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--accent) disabled:opacity-50',
                      isSelected
                        ? 'border-(--accent) bg-(--sidebar-active)'
                        : 'border-(--input-border) bg-(--chat-bg) hover:bg-(--sidebar-hover)',
                    )}
                  >
                    <span className="flex items-center justify-between gap-2 text-xs font-medium text-(--text-primary)">
                      <span className="truncate">{candidate.interfaceName}</span>
                      {candidate.isTailscale ? (
                        <span className="shrink-0 rounded-full border border-(--accent) px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-(--accent)">
                          {t('settings.remoteAccess.tailscaleAddress')}
                        </span>
                      ) : null}
                    </span>
                    <code className="mt-1 block truncate text-xs text-(--text-muted)">
                      {candidate.url}
                    </code>
                  </button>
                );
              })}
            </div>
          </div>
        ) : null}
        <div className="flex flex-col gap-2 sm:flex-row">
          <input
            id="advertised-address"
            type="url"
            value={address}
            onChange={(event) => {
              setAddress(event.target.value);
              setAddressError(null);
            }}
            placeholder={t('settings.remoteAccess.addressPlaceholder')}
            disabled={isLoading || isSaving}
            aria-invalid={Boolean(addressError)}
            aria-describedby={addressError ? 'advertised-address-error' : 'advertised-address-help'}
            className={cn(
              'min-w-0 flex-1 rounded-md border bg-(--input-bg) px-3 py-2 text-sm text-(--text-primary) outline-none transition-colors focus:ring-2 focus:ring-(--accent)',
              addressError ? 'border-(--status-error-border)' : 'border-(--input-border)',
            )}
          />
          <Button
            type="button"
            variant="outline"
            onClick={() => void handleSaveAddress()}
            disabled={isLoading || isSaving}
          >
            {isSaving ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
            {isSaving ? t('settings.remoteAccess.saving') : t('settings.remoteAccess.saveAddress')}
          </Button>
        </div>
        {addressError ? (
          <p id="advertised-address-error" className="text-xs text-(--status-error-text)">
            {addressError}
          </p>
        ) : (
          <p id="advertised-address-help" className="text-xs leading-5 text-(--text-muted)">
            {t('settings.remoteAccess.addressHelp')}
          </p>
        )}
      </div>

      <div className="border-t border-(--divider) pt-5">
        {!presentation ? (
          <div className="flex flex-col items-start justify-between gap-3 sm:flex-row sm:items-center">
            <div>
              <p className="text-sm font-medium text-(--text-primary)">
                {t('settings.remoteAccess.addDeviceTitle')}
              </p>
              <p className="mt-1 text-xs text-(--text-muted)">
                {t('settings.remoteAccess.addDeviceDescription')}
              </p>
            </div>
            <Button
              type="button"
              onClick={() => void handlePairing('issue')}
              disabled={!canAddDevice || isPairing}
              className="shrink-0"
            >
              {isPairing ? <RefreshCw className="h-4 w-4 animate-spin" /> : <QrCode className="h-4 w-4" />}
              {t('settings.remoteAccess.addDevice')}
            </Button>
          </div>
        ) : (
          <div className="grid gap-4 md:grid-cols-[auto_minmax(0,1fr)] md:items-start">
            {presentation.qrDataUrl ? (
              <div className="rounded-xl border border-(--divider) bg-white p-3 shadow-sm">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={presentation.qrDataUrl}
                  alt={t('settings.remoteAccess.qrAlt')}
                  className="h-48 w-48"
                />
              </div>
            ) : null}

            <div className="min-w-0 space-y-3">
              <div>
                <p className="flex items-center gap-2 text-sm font-medium text-(--text-primary)">
                  <Link2 className="h-4 w-4 text-(--accent)" />
                  {t('settings.remoteAccess.pairingReady')}
                </p>
                <p className="mt-1 text-xs leading-5 text-(--text-muted)">
                  {presentation.qrDataUrl
                    ? t('settings.remoteAccess.scanOrOpen')
                    : t('settings.remoteAccess.openLink')}
                </p>
              </div>

              <div className="flex min-w-0 items-center gap-2 rounded-lg border border-(--input-border) bg-(--input-bg) p-2">
                <code className="min-w-0 flex-1 truncate text-xs text-(--text-secondary)">
                  {presentation.pairingLink}
                </code>
                <Button type="button" size="sm" variant="outline" onClick={() => void handleCopyLink()}>
                  <Copy className="h-3.5 w-3.5" />
                  {t('settings.remoteAccess.copyLink')}
                </Button>
              </div>

              <div
                className={cn(
                  'flex flex-col gap-3 rounded-lg border p-3 sm:flex-row sm:items-center sm:justify-between',
                  isExpired
                    ? 'border-(--status-error-border) bg-(--status-error-bg) text-(--status-error-text)'
                    : 'border-(--status-info-border) bg-(--status-info-bg) text-(--status-info-text)',
                )}
              >
                <p className="text-xs font-medium">
                  {isExpired
                    ? t('settings.remoteAccess.expired')
                    : t('settings.remoteAccess.expiresIn', { time: formatRemaining(remainingMs) })}
                </p>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => void handlePairing('rotate')}
                  disabled={isPairing}
                >
                  <RefreshCw className={cn('h-3.5 w-3.5', isPairing && 'animate-spin')} />
                  {t('settings.remoteAccess.rotate')}
                </Button>
              </div>
            </div>
          </div>
        )}

        {pairingError ? (
          <p className="mt-3 text-xs text-(--status-error-text)">{pairingError}</p>
        ) : null}
      </div>

      <PairedDeviceManagement />
    </div>
  );
}
