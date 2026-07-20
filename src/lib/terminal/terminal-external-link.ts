'use client';

import { normalizeExternalHttpUrl } from '@/lib/external-http-url';

interface ElectronExternalUrlApi {
  isElectron?: boolean;
  openExternalUrl?: (url: string) => Promise<{ ok: boolean; error?: string }>;
}

export type ExternalUrlOpener = (url: string) => void | Promise<unknown>;

function getElectronExternalUrlApi(): ElectronExternalUrlApi | undefined {
  if (typeof window === 'undefined') return undefined;
  return (window as Window & { electronAPI?: ElectronExternalUrlApi }).electronAPI;
}

export function openExternalHttpUrl(url: string): void {
  const normalizedUrl = normalizeExternalHttpUrl(url);
  if (!normalizedUrl || typeof window === 'undefined') return;

  const electronApi = getElectronExternalUrlApi();
  if (electronApi?.isElectron && electronApi.openExternalUrl) {
    void electronApi.openExternalUrl(normalizedUrl);
    return;
  }

  window.open(normalizedUrl, '_blank', 'noopener,noreferrer');
}

export function createTerminalExternalLinkHandlers(
  openUrl: ExternalUrlOpener = openExternalHttpUrl,
) {
  const activate = (event: MouseEvent, rawUrl: string) => {
    const normalizedUrl = normalizeExternalHttpUrl(rawUrl);
    if (!normalizedUrl) return;

    event.preventDefault();
    void openUrl(normalizedUrl);
  };

  return {
    webLinkHandler: activate,
    oscLinkHandler: {
      activate: (event: MouseEvent, uri: string, _range?: unknown) => activate(event, uri),
    },
  };
}
