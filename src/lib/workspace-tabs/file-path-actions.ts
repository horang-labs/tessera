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
