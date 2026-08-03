'use client';

import { useEffect, useRef, useState } from 'react';

type PairingView =
  | 'redeeming'
  | 'missing'
  | 'expired'
  | 'used'
  | 'invalid'
  | 'rate-limited'
  | 'capacity'
  | 'network'
  | 'unexpected';

interface PairingErrorBody {
  code?: unknown;
  error?: unknown;
}

interface RedemptionRequest {
  token: string;
  promise: Promise<Response>;
}

declare global {
  interface Window {
    __tesseraPairingToken?: string;
    __tesseraPairingRedemption?: RedemptionRequest;
  }
}

const VIEW_COPY: Record<PairingView, {
  eyebrow: string;
  title: string;
  detail: string;
}> = {
  redeeming: {
    eyebrow: 'Secure handoff',
    title: 'Connecting this device',
    detail: 'Tessera is exchanging this one-time link for a private device credential.',
  },
  missing: {
    eyebrow: 'Pairing link needed',
    title: 'Open the complete link',
    detail: 'Scan the QR code again or open the link shown in Tessera on your main computer.',
  },
  expired: {
    eyebrow: 'Link expired',
    title: 'This pairing link has expired',
    detail: 'Pairing links last two minutes. Create a fresh one from Tessera and try again.',
  },
  used: {
    eyebrow: 'Link already claimed',
    title: 'This pairing link has already been used',
    detail: 'If this browser is not connected, create a new pairing link from Tessera.',
  },
  invalid: {
    eyebrow: 'Link not recognized',
    title: "This pairing link isn't valid",
    detail: 'Check that the full link was opened, or create a new one from Tessera.',
  },
  'rate-limited': {
    eyebrow: 'Pairing paused',
    title: 'Too many pairing attempts',
    detail: 'Wait a minute, then open a newly generated pairing link.',
  },
  capacity: {
    eyebrow: 'Device limit reached',
    title: 'No more devices can be added',
    detail: 'Remove an existing device in Tessera settings, then create a new pairing link.',
  },
  network: {
    eyebrow: 'Connection interrupted',
    title: "Couldn't reach Tessera",
    detail: 'Check this device’s connection to your Tessera address, then try again.',
  },
  unexpected: {
    eyebrow: 'Pairing interrupted',
    title: "Tessera couldn't connect this device",
    detail: 'Try the link again. If it still fails, create a fresh pairing link.',
  },
};

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

function redeem(token: string): Promise<Response> {
  const pending = window.__tesseraPairingRedemption;
  if (pending?.token === token) return pending.promise;

  const promise = fetch('/api/pairing/redeem', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    cache: 'no-store',
    referrerPolicy: 'no-referrer',
    body: JSON.stringify({ token }),
  });
  window.__tesseraPairingRedemption = { token, promise };
  const clearPendingRequest = () => {
    if (window.__tesseraPairingRedemption?.promise === promise) {
      delete window.__tesseraPairingRedemption;
    }
  };
  void promise.then(clearPendingRequest, clearPendingRequest);
  return promise;
}

function viewForError(code: unknown, status: number): PairingView {
  if (code === 'pairing-expired') return 'expired';
  if (code === 'pairing-used') return 'used';
  if (code === 'pairing-invalid' || code === 'invalid-request') return 'invalid';
  if (code === 'rate-limited' || status === 429) return 'rate-limited';
  if (code === 'capacity-reached') return 'capacity';
  return 'unexpected';
}

function deviceName(): string {
  const platform = navigator.platform?.trim();
  return platform ? `Browser on ${platform}` : 'Browser';
}

export function PairingClient() {
  const tokenRef = useRef<string | null | undefined>(undefined);
  const [view, setView] = useState<PairingView>('redeeming');
  const [attempt, setAttempt] = useState(0);

  useEffect(function redeemPairingLink() {
    let cancelled = false;
    if (tokenRef.current === undefined) {
      tokenRef.current = takePairingToken();
    }
    const token = tokenRef.current;

    if (!token) {
      queueMicrotask(() => {
        if (!cancelled) setView('missing');
      });
      return function ignoreMissingStateAfterLeaving() {
        cancelled = true;
      };
    }

    void redeem(token)
      .then(async (response) => {
        if (response.ok) {
          window.location.replace('/');
          return;
        }

        const body = await response.json().catch(() => null) as PairingErrorBody | null;
        if (!cancelled) setView(viewForError(body?.code, response.status));
      })
      .catch(() => {
        if (!cancelled) setView('network');
      });

    return function ignoreSettledRequestAfterLeaving() {
      cancelled = true;
    };
  }, [attempt]);

  const copy = VIEW_COPY[view];
  const isLoading = view === 'redeeming';
  const canRetry = view === 'network' || view === 'unexpected';
  const testId = view === 'missing' ? 'pairing-missing-token' : 'pairing-error';

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
            Device link
          </span>
        </header>

        <div
          role={isLoading ? 'status' : 'alert'}
          aria-live="polite"
          data-testid={isLoading ? 'pairing-progress' : testId}
          className="grid min-h-80 grid-cols-[2.75rem_1fr] gap-5 px-5 py-9 sm:grid-cols-[3.25rem_1fr] sm:gap-7 sm:px-8 sm:py-11"
        >
          <div className="flex flex-col items-center">
            <StatusMark view={view} />
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

            {isLoading ? (
              <div className="mt-auto flex items-center gap-2.5 pt-10 text-xs text-(--text-muted)">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-(--success) motion-reduce:animate-none" />
                The link has been removed from this address
              </div>
            ) : null}

            {canRetry ? (
              <button
                type="button"
                onClick={() => {
                  setView('redeeming');
                  setAttempt((current) => current + 1);
                }}
                className="mt-9 w-fit border border-(--input-border) bg-(--input-bg) px-4 py-2.5 text-sm font-medium text-(--text-primary) transition-colors hover:border-(--accent) hover:text-(--accent) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent)"
              >
                Try again
              </button>
            ) : null}
          </div>
        </div>

        <footer className="flex items-center justify-between gap-4 border-t border-(--divider) px-5 py-3.5 text-[0.68rem] text-(--text-muted) sm:px-7">
          <span>One-time encrypted credential exchange</span>
          <span className="font-mono uppercase tracking-[0.12em]">No token retained in URL</span>
        </footer>
      </section>
    </main>
  );
}

function TesseraMark() {
  return (
    <span aria-hidden="true" className="grid h-7 w-7 grid-cols-2 gap-0.5 border border-(--input-border) bg-(--input-bg) p-1">
      <span className="bg-(--accent)" />
      <span className="bg-(--text-muted)" />
      <span className="bg-(--text-muted)" />
      <span className="bg-(--accent)" />
    </span>
  );
}

function StatusMark({ view }: { view: PairingView }) {
  if (view === 'redeeming') {
    return (
      <span
        aria-hidden="true"
        className="grid h-11 w-11 animate-spin place-items-center rounded-full border border-(--accent) border-r-transparent motion-reduce:animate-none"
      >
        <span className="h-2 w-2 rounded-full bg-(--accent)" />
      </span>
    );
  }

  const isMissing = view === 'missing';
  return (
    <span
      aria-hidden="true"
      className={`grid h-11 w-11 place-items-center rounded-full border ${
        isMissing
          ? 'border-(--status-info-border) bg-(--status-info-bg) text-(--status-info-text)'
          : 'border-(--status-error-border) bg-(--status-error-bg) text-(--status-error-text)'
      }`}
    >
      <span className="text-lg font-medium leading-none">{isMissing ? 'i' : '×'}</span>
    </span>
  );
}
