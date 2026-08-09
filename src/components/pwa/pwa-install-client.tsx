'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useI18n } from '@/lib/i18n';
import { TesseraMark } from '@/components/brand/tessera-mark';
import {
  completePwaInstallGuidance,
  detectIosInstallSupport,
  hasCompletedPwaInstallGuidance,
  isInstalledPwa,
} from '@/lib/pwa/install-guidance';

type InstallView =
  | 'checking'
  | 'ready'
  | 'ios'
  | 'unsupported-ios-version'
  | 'unsupported-ios-browser'
  | 'unsupported'
  | 'dismissed';

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
}

declare global {
  interface Window {
    __tesseraInstallPrompt?: BeforeInstallPromptEvent;
    __tesseraInstallPromptCapture?: EventListener;
  }
}

export function PwaInstallClient() {
  const { t } = useI18n();
  const router = useRouter();
  const promptRef = useRef<BeforeInstallPromptEvent | null>(null);
  const observeBrowserPromptRef = useRef(false);
  const [authenticated, setAuthenticated] = useState(false);
  const [view, setView] = useState<InstallView>('checking');

  useEffect(function verifyPairedDevice() {
    let cancelled = false;
    void fetch('/api/auth/me', { cache: 'no-store', credentials: 'same-origin' })
      .then((response) => {
        if (cancelled) return;
        if (!response.ok) {
          router.replace('/login');
          return;
        }
        if (isInstalledPwa() || hasCompletedPwaInstallGuidance()) {
          router.replace('/chat');
          return;
        }
        const ios = detectIosInstallSupport();
        if (ios.kind === 'supported') setView('ios');
        else if (ios.kind === 'unsupported') {
          setView(ios.reason === 'browser' ? 'unsupported-ios-browser' : 'unsupported-ios-version');
        } else {
          observeBrowserPromptRef.current = true;
          const capturedPrompt = window.__tesseraInstallPrompt;
          if (capturedPrompt) {
            promptRef.current = capturedPrompt;
            delete window.__tesseraInstallPrompt;
            setView('ready');
          }
        }
        setAuthenticated(true);
      })
      .catch(() => {
        if (!cancelled) router.replace('/login');
      });
    return function ignoreAuthenticationAfterLeaving() {
      cancelled = true;
    };
  }, [router]);

  useEffect(function observeInstallability() {
    if (!authenticated || !observeBrowserPromptRef.current) return;

    const unavailableTimer = window.setTimeout(() => setView('unsupported'), 1_200);
    const handleInstallPrompt = (event: Event) => {
      event.preventDefault();
      window.clearTimeout(unavailableTimer);
      promptRef.current = event as BeforeInstallPromptEvent;
      delete window.__tesseraInstallPrompt;
      setView('ready');
    };
    const handleInstalled = () => {
      completePwaInstallGuidance('installed');
      router.replace('/chat');
    };
    window.addEventListener('beforeinstallprompt', handleInstallPrompt);
    window.addEventListener('appinstalled', handleInstalled);
    const capturedPrompt = window.__tesseraInstallPrompt;
    if (capturedPrompt) handleInstallPrompt(capturedPrompt);
    const bootstrapCapture = window.__tesseraInstallPromptCapture;
    if (bootstrapCapture) {
      window.removeEventListener('beforeinstallprompt', bootstrapCapture);
      delete window.__tesseraInstallPromptCapture;
    }
    return function stopObservingInstallability() {
      window.clearTimeout(unavailableTimer);
      window.removeEventListener('beforeinstallprompt', handleInstallPrompt);
      window.removeEventListener('appinstalled', handleInstalled);
    };
  }, [authenticated, router]);

  const continueInBrowser = () => {
    completePwaInstallGuidance('dismissed');
    router.push('/chat');
  };

  const confirmIosInstallation = () => {
    completePwaInstallGuidance('installed');
    router.push('/chat');
  };

  const requestInstallation = async () => {
    const prompt = promptRef.current;
    if (!prompt) return;
    promptRef.current = null;
    await prompt.prompt();
    const choice = await prompt.userChoice;
    if (choice.outcome === 'accepted') {
      completePwaInstallGuidance('installed');
      router.push('/chat');
      return;
    }
    completePwaInstallGuidance('dismissed');
    setView('dismissed');
  };

  if (!authenticated) return null;

  return (
    <main className="relative isolate flex min-h-dvh items-center justify-center overflow-hidden bg-(--chat-bg) px-4 py-6 text-(--text-primary) sm:px-6 sm:py-10">
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 opacity-70">
        <div className="absolute -left-20 top-16 h-48 w-48 rounded-full border border-(--divider)" />
        <div className="absolute -right-24 bottom-8 h-64 w-64 rotate-12 border border-(--divider)" />
      </div>

      <section className="relative w-full max-w-xl border border-(--divider) bg-(--sidebar-bg) shadow-2xl shadow-black/10 dark:shadow-black/40">
        <header className="flex items-center justify-between border-b border-(--divider) px-5 py-4 sm:px-7">
          <div className="flex items-center gap-3">
            <TesseraMark />
            <span className="text-sm font-semibold tracking-[0.16em] text-(--text-secondary)">TESSERA</span>
          </div>
          <span className="font-mono text-[0.65rem] uppercase tracking-[0.18em] text-(--text-muted)">
            {t('pwaInstall.optional')}
          </span>
        </header>

        <div data-testid={testIdFor(view)} className="px-5 py-7 sm:px-8 sm:py-10">
          <p className="text-[0.68rem] font-semibold uppercase tracking-[0.22em] text-(--accent)">
            {t('pwaInstall.eyebrow')}
          </p>
          <h1 className="mt-3 text-balance text-3xl font-semibold leading-tight tracking-[-0.035em] sm:text-4xl">
            {titleFor(view, t)}
          </h1>
          <p className="mt-4 max-w-md text-pretty text-sm leading-6 text-(--text-secondary)">
            {detailFor(view, t)}
          </p>

          {view === 'ios' ? (
            <ol className="mt-6 grid gap-3 border-y border-(--divider) py-5 text-sm text-(--text-secondary)">
              <li className="flex gap-3"><Step number="1" />{t('pwaInstall.iosShare')}</li>
              <li className="flex gap-3"><Step number="2" />{t('pwaInstall.iosHomeScreen')}</li>
            </ol>
          ) : null}

          <div className="mt-7 flex flex-col gap-3 sm:flex-row sm:items-center">
            {view === 'ready' ? (
              <button type="button" onClick={() => void requestInstallation()} className="min-h-11 bg-(--accent) px-5 py-2.5 text-sm font-semibold text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent)">
                {t('pwaInstall.installButton')}
              </button>
            ) : null}
            {view === 'ios' ? (
              <button type="button" onClick={confirmIosInstallation} className="min-h-11 bg-(--accent) px-5 py-2.5 text-sm font-semibold text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent)">
                {t('pwaInstall.iosDone')}
              </button>
            ) : null}
            <button type="button" onClick={continueInBrowser} className="min-h-11 border border-(--input-border) bg-(--input-bg) px-5 py-2.5 text-sm font-medium text-(--text-primary) transition-colors hover:border-(--accent) hover:text-(--accent) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent)">
              {t('pwaInstall.continueBrowser')}
            </button>
          </div>
        </div>

        <footer className="flex items-center justify-between gap-4 border-t border-(--divider) px-5 py-3.5 text-[0.68rem] text-(--text-muted) sm:px-7">
          <span>{t('pwaInstall.footerPrivate')}</span>
          <span className="font-mono uppercase tracking-[0.12em]">{t('pwaInstall.footerOptional')}</span>
        </footer>
      </section>
    </main>
  );
}

function testIdFor(view: InstallView): string {
  if (view === 'ready') return 'pwa-install-ready';
  if (view === 'ios') return 'pwa-install-ios';
  if (view.startsWith('unsupported')) return 'pwa-install-unsupported';
  if (view === 'dismissed') return 'pwa-install-dismissed';
  return 'pwa-install-checking';
}

function titleFor(view: InstallView, t: ReturnType<typeof useI18n>['t']): string {
  if (view === 'ready') return t('pwaInstall.readyTitle');
  if (view === 'ios') return t('pwaInstall.iosTitle');
  if (view === 'unsupported-ios-version') return t('pwaInstall.unsupportedIosTitle');
  if (view === 'unsupported-ios-browser') return t('pwaInstall.unsupportedIosBrowserTitle');
  if (view === 'unsupported') return t('pwaInstall.unsupportedTitle');
  if (view === 'dismissed') return t('pwaInstall.dismissedTitle');
  return t('pwaInstall.checkingTitle');
}

function detailFor(view: InstallView, t: ReturnType<typeof useI18n>['t']): string {
  if (view === 'ready') return t('pwaInstall.readyDetail');
  if (view === 'ios') return t('pwaInstall.iosDetail');
  if (view === 'unsupported-ios-version') return t('pwaInstall.unsupportedIosDetail');
  if (view === 'unsupported-ios-browser') return t('pwaInstall.unsupportedIosBrowserDetail');
  if (view === 'unsupported') return t('pwaInstall.unsupportedDetail');
  if (view === 'dismissed') return t('pwaInstall.dismissedDetail');
  return t('pwaInstall.checkingDetail');
}

function Step({ number }: { number: string }) {
  return <span aria-hidden="true" className="grid h-6 w-6 shrink-0 place-items-center border border-(--input-border) font-mono text-xs text-(--accent)">{number}</span>;
}
