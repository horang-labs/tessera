export type DesktopUpdateEventType =
  | 'checking'
  | 'available'
  | 'not-available'
  | 'progress'
  | 'downloaded'
  | 'error';

export interface DesktopUpdateInfo {
  version: string | null;
  releaseDate?: string | null;
  releaseName?: string | null;
  releaseNotes?: string | null;
}

export interface DesktopUpdateProgress {
  percent: number;
  bytesPerSecond: number;
  transferred: number;
  total: number;
}

export interface DesktopUpdateEvent {
  type: DesktopUpdateEventType;
  info?: DesktopUpdateInfo;
  progress?: DesktopUpdateProgress;
  error?: string;
}

export interface DesktopUpdateResult {
  status: 'unsupported' | 'checking' | 'available' | 'current' | 'downloaded' | 'error';
  currentVersion: string;
  updateAvailable: boolean;
  latestVersion: string | null;
  error: string | null;
}

export interface ElectronUpdaterApi {
  checkForDesktopUpdate: () => Promise<DesktopUpdateResult>;
  downloadDesktopUpdate: () => Promise<DesktopUpdateResult>;
  installDesktopUpdate: () => Promise<void>;
  onDesktopUpdateEvent: (callback: (event: DesktopUpdateEvent) => void) => (() => void) | void;
}
