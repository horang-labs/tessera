"use client";

interface ElectronFileApi {
  isElectron?: boolean;
  platform?: string;
  openFilePath?: (path: string) => Promise<{ ok: boolean; error?: string }>;
  revealFilePath?: (path: string) => Promise<{ ok: boolean; error?: string }>;
}

function getElectronFileApi(): ElectronFileApi | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as Window & { electronAPI?: ElectronFileApi }).electronAPI;
}

export function toAbsoluteWorkspacePath(
  workDir: string | null | undefined,
  relativePath: string,
): string | null {
  const trimmedBase = workDir?.trim();
  const trimmedPath = relativePath.trim();

  if (!trimmedPath) return trimmedBase ?? null;
  if (!trimmedBase) return null;

  const separator = trimmedBase.includes("\\") ? "\\" : "/";
  const normalizedRelativePath = trimmedPath.replace(/^[\\/]+/, "").replace(/[\\/]/g, separator);

  return trimmedBase.endsWith(separator)
    ? `${trimmedBase}${normalizedRelativePath}`
    : `${trimmedBase}${separator}${normalizedRelativePath}`;
}

const WINDOWS_ABSOLUTE_PATH = /^[A-Za-z]:[\\/]/;

/**
 * Detects whether a markdown link href points at a local file on the host
 * filesystem (rather than a web URL, mail/tel link, or in-page anchor) and
 * returns the normalized filesystem path. Returns null for anything that is
 * not an openable local path.
 *
 * Recognizes: `file://` URLs (incl. `file:///C:/...`), Windows absolute paths
 * (`C:\...` / `C:/...`), and POSIX absolute paths (`/...`, excluding
 * protocol-relative `//host`). Web schemes, relative paths, and `#anchors`
 * are intentionally left as normal links.
 */
export function parseLocalFileHref(href: string | null | undefined): string | null {
  if (!href) return null;
  const trimmed = href.trim();
  if (!trimmed) return null;

  if (/^file:\/\//i.test(trimmed)) {
    try {
      const decoded = decodeURIComponent(new URL(trimmed).pathname);
      // `file:///C:/path` decodes to `/C:/path`; drop the leading slash so the
      // OS receives a valid drive path.
      return (/^\/[A-Za-z]:/.test(decoded) ? decoded.slice(1) : decoded) || null;
    } catch {
      return null;
    }
  }

  if (WINDOWS_ABSOLUTE_PATH.test(trimmed)) return trimmed;

  if (trimmed.startsWith("/") && !trimmed.startsWith("//")) return trimmed;

  return null;
}

export function getElectronPlatform(): string | null {
  const electronApi = getElectronFileApi();
  return electronApi?.isElectron ? (electronApi.platform ?? null) : null;
}

export function canUseElectronFileActions(): boolean {
  const electronApi = getElectronFileApi();
  return Boolean(
    electronApi?.isElectron
    && electronApi.openFilePath
    && electronApi.revealFilePath,
  );
}

export function getRevealFileLabel(platform: string | null | undefined): string {
  if (platform === "darwin") return "Show in Finder";
  if (platform === "win32") return "Show in Explorer";
  return "Show in folder";
}

export function copyText(value: string | null | undefined) {
  if (!value || typeof navigator === "undefined" || !navigator.clipboard) return;
  void navigator.clipboard.writeText(value);
}

export function openFilePathOnHost(path: string | null | undefined) {
  if (!path) return;
  const electronApi = getElectronFileApi();
  if (!electronApi?.isElectron || !electronApi.openFilePath) return;
  void electronApi.openFilePath(path);
}

export function revealFilePathOnHost(path: string | null | undefined) {
  if (!path) return;
  const electronApi = getElectronFileApi();
  if (!electronApi?.isElectron || !electronApi.revealFilePath) return;
  void electronApi.revealFilePath(path);
}
