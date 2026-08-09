export const PWA_INSTALL_GUIDANCE_STORAGE_KEY = 'tessera:pwa-install-guidance:v1';

export type IosInstallSupport =
  | { kind: 'not-ios' }
  | { kind: 'supported'; version: string }
  | { kind: 'unsupported'; reason: 'browser' | 'version'; version: string | null };

export function isInstalledPwa(): boolean {
  if (typeof window === 'undefined') return false;
  const navigatorWithStandalone = navigator as Navigator & { standalone?: boolean };
  return window.matchMedia('(display-mode: standalone)').matches
    || navigatorWithStandalone.standalone === true;
}

export function hasCompletedPwaInstallGuidance(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(PWA_INSTALL_GUIDANCE_STORAGE_KEY) !== null;
  } catch {
    return false;
  }
}

export function completePwaInstallGuidance(outcome: 'installed' | 'dismissed'): void {
  try {
    window.localStorage.setItem(PWA_INSTALL_GUIDANCE_STORAGE_KEY, outcome);
  } catch {
    // Private browsing can deny storage; the current navigation still succeeds.
  }
}

export function postPairingDestination(): '/chat' | '/install' {
  return isInstalledPwa() || hasCompletedPwaInstallGuidance() ? '/chat' : '/install';
}

export function detectIosInstallSupport(): IosInstallSupport {
  if (typeof navigator === 'undefined') return { kind: 'not-ios' };

  const userAgent = navigator.userAgent;
  const isMobileIos = /iPhone|iPad|iPod/i.test(userAgent);
  const isDesktopModeIpad = navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
  if (!isMobileIos && !isDesktopModeIpad) return { kind: 'not-ios' };

  const versionMatch = userAgent.match(/(?:CPU (?:iPhone )?OS|OS) (\d+)[._](\d+)/i)
    ?? (isDesktopModeIpad ? userAgent.match(/Version\/(\d+)\.(\d+)/i) : null);
  if (!versionMatch) return { kind: 'unsupported', reason: 'version', version: null };

  const major = Number(versionMatch[1]);
  const minor = Number(versionMatch[2]);
  const version = `${major}.${minor}`;
  if (major < 17 || (major === 17 && minor < 2)) {
    return { kind: 'unsupported', reason: 'version', version };
  }

  const isSafari = /Version\/\d+(?:\.\d+)?[^\n]*Safari\//i.test(userAgent)
    && !/(?:CriOS|FxiOS|EdgiOS|OPiOS)\//i.test(userAgent);
  return isSafari
    ? { kind: 'supported', version }
    : { kind: 'unsupported', reason: 'browser', version };
}
