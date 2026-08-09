'use client';

import { useEffect, useRef, useState } from 'react';
import type { TFunction } from 'i18next';
import { isPairingRequest, type PairingRequest } from '@/lib/auth/pairing-contract';
import { useI18n } from '@/lib/i18n';
import { formatPairingTimeRemaining } from './pairing-time';
import { postPairingDestination } from '@/lib/pwa/install-guidance';
import { TesseraMark } from '@/components/brand/tessera-mark';

type PairingView =
  | 'requesting'
  | 'waiting'
  | 'approved'
  | 'missing'
  | 'expired'
  | 'denied'
  | 'used'
  | 'invalid'
  | 'rate-limited'
  | 'capacity'
  | 'network'
  | 'unexpected';

type PairingStatusMark = 'requesting' | 'waiting' | 'success' | 'info' | 'error';

interface PairingViewDefinition {
  eyebrow: string;
  title: string;
  detail: string;
  testId: string;
  role: 'status' | 'alert';
  ariaLive: 'polite' | 'assertive';
  mark: PairingStatusMark;
}

const PAIRING_VIEW_DEFINITIONS: Record<PairingView, PairingViewDefinition> = {
  requesting: {
    eyebrow: 'pairing.requestingEyebrow',
    title: 'pairing.requestingTitle',
    detail: 'pairing.requestingDetail',
    testId: 'pairing-requesting',
    role: 'status',
    ariaLive: 'polite',
    mark: 'requesting',
  },
  waiting: {
    eyebrow: 'pairing.waitingEyebrow',
    title: 'pairing.waitingTitle',
    detail: 'pairing.waitingDetail',
    testId: 'pairing-waiting',
    role: 'status',
    ariaLive: 'polite',
    mark: 'waiting',
  },
  approved: {
    eyebrow: 'pairing.approvedEyebrow',
    title: 'pairing.approvedTitle',
    detail: 'pairing.approvedDetail',
    testId: 'pairing-approved',
    role: 'status',
    ariaLive: 'assertive',
    mark: 'success',
  },
  missing: {
    eyebrow: 'pairing.missingEyebrow',
    title: 'pairing.missingTitle',
    detail: 'pairing.missingDetail',
    testId: 'pairing-missing-token',
    role: 'alert',
    ariaLive: 'polite',
    mark: 'info',
  },
  expired: {
    eyebrow: 'pairing.expiredEyebrow',
    title: 'pairing.expiredTitle',
    detail: 'pairing.expiredDetail',
    testId: 'pairing-error',
    role: 'alert',
    ariaLive: 'polite',
    mark: 'error',
  },
  denied: {
    eyebrow: 'pairing.deniedEyebrow',
    title: 'pairing.deniedTitle',
    detail: 'pairing.deniedDetail',
    testId: 'pairing-denied',
    role: 'alert',
    ariaLive: 'assertive',
    mark: 'error',
  },
  used: {
    eyebrow: 'pairing.usedEyebrow',
    title: 'pairing.usedTitle',
    detail: 'pairing.usedDetail',
    testId: 'pairing-error',
    role: 'alert',
    ariaLive: 'polite',
    mark: 'error',
  },
  invalid: {
    eyebrow: 'pairing.invalidEyebrow',
    title: 'pairing.invalidTitle',
    detail: 'pairing.invalidDetail',
    testId: 'pairing-error',
    role: 'alert',
    ariaLive: 'polite',
    mark: 'error',
  },
  'rate-limited': {
    eyebrow: 'pairing.rateLimitedEyebrow',
    title: 'pairing.rateLimitedTitle',
    detail: 'pairing.rateLimitedDetail',
    testId: 'pairing-error',
    role: 'alert',
    ariaLive: 'polite',
    mark: 'error',
  },
  capacity: {
    eyebrow: 'pairing.capacityEyebrow',
    title: 'pairing.capacityTitle',
    detail: 'pairing.capacityDetail',
    testId: 'pairing-error',
    role: 'alert',
    ariaLive: 'polite',
    mark: 'error',
  },
  network: {
    eyebrow: 'pairing.networkEyebrow',
    title: 'pairing.networkTitle',
    detail: 'pairing.networkDetail',
    testId: 'pairing-error',
    role: 'alert',
    ariaLive: 'polite',
    mark: 'error',
  },
  unexpected: {
    eyebrow: 'pairing.unexpectedEyebrow',
    title: 'pairing.unexpectedTitle',
    detail: 'pairing.unexpectedDetail',
    testId: 'pairing-error',
    role: 'alert',
    ariaLive: 'polite',
    mark: 'error',
  },
};

interface PairingErrorBody {
  code?: unknown;
  error?: unknown;
  status?: unknown;
}

interface PairingClaimBody extends PairingErrorBody {
  request?: unknown;
}

interface ClaimRequest {
  token: string;
  promise: Promise<Response>;
}

declare global {
  interface Window {
    __tesseraPairingToken?: string;
    __tesseraPairingClaim?: ClaimRequest;
  }
}

function takePairingToken(): string | null {
  const bootstrappedToken = window.__tesseraPairingToken;
  delete window.__tesseraPairingToken;

  if (window.location.hash) {
    const fallbackToken = new URLSearchParams(window.location.hash.slice(1)).get('t');
    window.history.replaceState(
      window.history.state,
      '',
      `${window.location.pathname}${window.location.search}`,
    );
    return bootstrappedToken || fallbackToken || null;
  }

  return bootstrappedToken || null;
}

function claimPairingRequest(token: string): Promise<Response> {
  const activeClaim = window.__tesseraPairingClaim;
  if (activeClaim?.token === token) return activeClaim.promise;

  const promise = fetch('/api/pairing/requests', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    cache: 'no-store',
    referrerPolicy: 'no-referrer',
    body: JSON.stringify({ token, name: deviceName() }),
  });
  window.__tesseraPairingClaim = { token, promise };
  const clearClaim = () => {
    if (window.__tesseraPairingClaim?.promise === promise) {
      delete window.__tesseraPairingClaim;
    }
  };
  void promise.then(clearClaim, clearClaim);
  return promise;
}

function pollPairingRequest(requestId: string): Promise<Response> {
  return fetch(`/api/pairing/requests/${encodeURIComponent(requestId)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    cache: 'no-store',
    referrerPolicy: 'no-referrer',
    body: '{}',
  });
}

function viewForError(code: unknown, status: number, state?: unknown): PairingView {
  if (state === 'denied') return 'denied';
  if (state === 'expired' || code === 'pairing-expired') return 'expired';
  if (state === 'used' || code === 'pairing-used') return 'used';
  if (code === 'pairing-invalid' || code === 'invalid-request') return 'invalid';
  if (code === 'rate-limited' || status === 429) return 'rate-limited';
  if (code === 'capacity-reached') return 'capacity';
  return 'unexpected';
}

function deviceName(): string {
  const platform = navigator.platform?.trim();
  return platform ? `Browser on ${platform}` : 'Browser';
}

function copyForView(view: PairingView, t: TFunction) {
  const definition = PAIRING_VIEW_DEFINITIONS[view];
  return {
    eyebrow: t(definition.eyebrow),
    title: t(definition.title),
    detail: t(definition.detail),
  };
}

export function PairingClient() {
  const { t } = useI18n();
  const tokenRef = useRef<string | null | undefined>(undefined);
  const [request, setRequest] = useState<PairingRequest | null>(null);
  const [view, setView] = useState<PairingView>('requesting');
  const [attempt, setAttempt] = useState(0);
  const [now, setNow] = useState(() => Date.now());

  useEffect(function claimPairingLink() {
    if (request) return;
    let cancelled = false;
    if (tokenRef.current === undefined) tokenRef.current = takePairingToken();
    const token = tokenRef.current;

    if (!token) {
      queueMicrotask(() => {
        if (!cancelled) setView('missing');
      });
      return function ignoreMissingStateAfterLeaving() {
        cancelled = true;
      };
    }

    void claimPairingRequest(token)
      .then(async (response) => {
        const body = await response.json().catch(() => null) as PairingClaimBody | null;
        if (!response.ok || !isPairingRequest(body?.request)) {
          if (!cancelled) setView(viewForError(body?.code, response.status, body?.status));
          return;
        }
        if (!cancelled) {
          setRequest(body.request);
          setNow(Date.now());
          setView(body.request.status === 'approved' ? 'approved' : 'waiting');
        }
      })
      .catch(() => {
        if (!cancelled) setView('network');
      });

    return function ignoreClaimAfterLeaving() {
      cancelled = true;
    };
  }, [attempt, request]);

  useEffect(function waitForLocalApproval() {
    if (!request) return;
    let cancelled = false;
    let nextPoll: number | undefined;
    let redirectTimer: number | undefined;

    const poll = async () => {
      try {
        const response = await pollPairingRequest(request.id);
        const body = await response.json().catch(() => null) as PairingErrorBody | null;
        if (cancelled) return;

        if (response.ok && body?.status === 'pending') {
          setView('waiting');
          nextPoll = window.setTimeout(() => void poll(), 900);
          return;
        }
        if (response.ok && body?.status === 'approved') {
          setView('approved');
          redirectTimer = window.setTimeout(
            () => window.location.replace(postPairingDestination()),
            700,
          );
          return;
        }
        setView(viewForError(body?.code, response.status, body?.status));
      } catch {
        if (!cancelled) setView('network');
      }
    };

    void poll();
    return function stopApprovalPolling() {
      cancelled = true;
      if (nextPoll !== undefined) window.clearTimeout(nextPoll);
      if (redirectTimer !== undefined) window.clearTimeout(redirectTimer);
    };
  }, [attempt, request]);

  useEffect(function tickPairingExpiry() {
    if (!request || view !== 'waiting') return;
    const interval = window.setInterval(() => setNow(Date.now()), 1_000);
    return function stopPairingExpiryClock() {
      window.clearInterval(interval);
    };
  }, [request, view]);

  const copy = copyForView(view, t);
  const definition = PAIRING_VIEW_DEFINITIONS[view];
  const canRetry = view === 'network' || view === 'unexpected';
  const remainingMs = request ? Date.parse(request.expiresAt) - now : 0;

  return (
    <main className="relative isolate flex min-h-screen items-center justify-center overflow-hidden bg-(--chat-bg) px-5 py-10 text-(--text-primary)">
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 opacity-70">
        <div className="absolute -left-24 top-1/2 h-72 w-72 -translate-y-1/2 rounded-full border border-(--divider)" />
        <div className="absolute -left-10 top-1/2 h-44 w-44 -translate-y-1/2 rounded-full border border-(--divider)" />
        <div className="absolute -right-28 top-8 h-56 w-56 rotate-12 border border-(--divider)" />
        <div className="absolute bottom-10 right-10 h-px w-24 bg-(--divider)" />
      </div>

      <section className="relative w-full max-w-xl border border-(--divider) bg-(--sidebar-bg) shadow-2xl shadow-black/10 dark:shadow-black/40">
        <header className="flex items-center justify-between border-b border-(--divider) px-5 py-4 sm:px-7">
          <div className="flex items-center gap-3">
            <TesseraMark />
            <span className="text-sm font-semibold tracking-[0.16em] text-(--text-secondary)">
              TESSERA
            </span>
          </div>
          <span className="font-mono text-[0.65rem] uppercase tracking-[0.2em] text-(--text-muted)">
            {t('pairing.deviceLink')}
          </span>
        </header>

        <div
          role={definition.role}
          aria-live={definition.ariaLive}
          data-testid={definition.testId}
          className="grid min-h-96 grid-cols-[2.75rem_1fr] gap-5 px-5 py-9 sm:grid-cols-[3.25rem_1fr] sm:gap-7 sm:px-8 sm:py-11"
        >
          <div className="flex flex-col items-center">
            <StatusMark mark={definition.mark} />
            <div className="mt-4 min-h-28 w-px flex-1 bg-(--divider)" />
          </div>

          <div className="flex min-w-0 flex-col">
            <p className="mb-3 text-[0.68rem] font-semibold uppercase tracking-[0.22em] text-(--accent)">
              {copy.eyebrow}
            </p>
            <h1 className="max-w-md text-balance text-3xl font-semibold leading-tight tracking-[-0.035em] sm:text-4xl">
              {copy.title}
            </h1>
            <p className="mt-5 max-w-md text-pretty text-sm leading-6 text-(--text-secondary) sm:text-[0.95rem]">
              {copy.detail}
            </p>

            {view === 'waiting' && request ? (
              <div className="mt-8 border-y border-(--divider) py-5">
                <p className="text-[0.65rem] font-semibold uppercase tracking-[0.2em] text-(--text-muted)">
                  {t('pairing.comparisonCode')}
                </p>
                <p className="mt-2 font-mono text-4xl font-semibold tracking-[0.22em] text-(--text-primary)">
                  {request.comparisonCode.slice(0, 3)} {request.comparisonCode.slice(3)}
                </p>
                <div className="mt-4 flex items-center justify-between gap-4 text-xs text-(--text-muted)">
                  <span>{t('pairing.approveInApp')}</span>
                  <span className="shrink-0 font-mono tabular-nums">
                    {t('pairing.expiresIn', {
                      time: formatPairingTimeRemaining(remainingMs),
                    })}
                  </span>
                </div>
              </div>
            ) : null}

            {view === 'requesting' ? (
              <div className="mt-auto flex items-center gap-2.5 pt-10 text-xs text-(--text-muted)">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-(--success) motion-reduce:animate-none" />
                {t('pairing.tokenRemoved')}
              </div>
            ) : null}

            {canRetry ? (
              <button
                type="button"
                onClick={() => {
                  setView(request ? 'waiting' : 'requesting');
                  setAttempt((current) => current + 1);
                }}
                className="mt-9 w-fit border border-(--input-border) bg-(--input-bg) px-4 py-2.5 text-sm font-medium text-(--text-primary) transition-colors hover:border-(--accent) hover:text-(--accent) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent)"
              >
                {t('pairing.tryAgain')}
              </button>
            ) : null}
          </div>
        </div>

        <footer className="flex items-center justify-between gap-4 border-t border-(--divider) px-5 py-3.5 text-[0.68rem] text-(--text-muted) sm:px-7">
          <span>{t('pairing.footerApproval')}</span>
          <span className="font-mono uppercase tracking-[0.12em]">{t('pairing.footerNoToken')}</span>
        </footer>
      </section>
    </main>
  );
}

function StatusMark({ mark }: { mark: PairingStatusMark }) {
  if (mark === 'requesting') {
    return (
      <span
        aria-hidden="true"
        className="grid h-11 w-11 animate-spin place-items-center rounded-full border border-(--accent) border-r-transparent motion-reduce:animate-none"
      >
        <span className="h-2 w-2 rounded-full bg-(--accent)" />
      </span>
    );
  }

  if (mark === 'waiting') {
    return (
      <span aria-hidden="true" className="relative grid h-11 w-11 place-items-center rounded-full border border-(--status-warning-border) bg-(--status-warning-bg)">
        <span className="absolute h-2.5 w-2.5 animate-ping rounded-full bg-(--status-warning-text) motion-reduce:animate-none" />
        <span className="relative h-2.5 w-2.5 rounded-full bg-(--status-warning-text)" />
      </span>
    );
  }

  const isSuccess = mark === 'success';
  const isMissing = mark === 'info';
  return (
    <span
      aria-hidden="true"
      className={`grid h-11 w-11 place-items-center rounded-full border ${
        isSuccess
          ? 'border-(--status-success-border) bg-(--status-success-bg) text-(--status-success-text)'
          : isMissing
            ? 'border-(--status-info-border) bg-(--status-info-bg) text-(--status-info-text)'
            : 'border-(--status-error-border) bg-(--status-error-bg) text-(--status-error-text)'
      }`}
    >
      <span className="text-lg font-medium leading-none">{isSuccess ? '✓' : isMissing ? 'i' : '×'}</span>
    </span>
  );
}
