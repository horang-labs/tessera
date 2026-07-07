import { randomUUID } from 'crypto';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { getServerHostInfo } from '@/lib/system/server-host';
import type { ServerHostInfo } from '@/lib/system/types';
import { getTesseraDataDir, getTesseraDataPath } from '@/lib/tessera-data-dir';

export interface TelemetryInstallState {
  installId: string;
  firstRunCapturedAt: string | null;
  firstRunSkippedAt: string | null;
  firstRunSkipReason: FirstRunSkipReason | null;
}

export interface TelemetryBootstrapInfo extends TelemetryInstallState {
  serverHostInfo: ServerHostInfo;
  firstRunEligible: boolean;
}

type FirstRunDisposition = 'captured' | 'skipped';
export type FirstRunSkipReason =
  | 'client_disabled'
  | 'existing_install_data'
  | 'telemetry_disabled_by_env'
  | 'unknown';

const TELEMETRY_STATE_FILE = 'telemetry.json';
const EXISTING_INSTALL_MARKERS = [
  'users.json',
  'settings',
  'session-history',
  'session-exports',
  'attachments',
  'worktrees',
  'tessera.db',
  'tessera-dev.db',
] as const;

let startupHadExistingInstallData: boolean | null = null;

export function snapshotTelemetryStartupDataState(): boolean {
  startupHadExistingInstallData = hasExistingInstallData();
  return startupHadExistingInstallData;
}

export async function getTelemetryBootstrapInfo(
  serverHostInfo: ServerHostInfo = getServerHostInfo(),
): Promise<TelemetryBootstrapInfo> {
  let state = await readTelemetryInstallState();
  const now = new Date().toISOString();

  if (!state) {
    state = createTelemetryInstallState();
    if (serverHostInfo.telemetryDisabledByEnv || startupHadExistingInstallData === true) {
      state.firstRunSkippedAt = now;
      state.firstRunSkipReason = serverHostInfo.telemetryDisabledByEnv
        ? 'telemetry_disabled_by_env'
        : 'existing_install_data';
    }
    await writeTelemetryInstallState(state);
  } else if (
    !state.firstRunCapturedAt
    && !state.firstRunSkippedAt
    && serverHostInfo.telemetryDisabledByEnv
  ) {
    state = {
      ...state,
      firstRunSkippedAt: now,
      firstRunSkipReason: 'telemetry_disabled_by_env',
    };
    await writeTelemetryInstallState(state);
  }

  return {
    ...state,
    serverHostInfo,
    firstRunEligible: !serverHostInfo.telemetryDisabledByEnv
      && !state.firstRunCapturedAt
      && !state.firstRunSkippedAt,
  };
}

export async function markTelemetryFirstRun(
  disposition: FirstRunDisposition,
  options: { skipReason?: FirstRunSkipReason | null } = {},
): Promise<TelemetryInstallState> {
  const current = await readTelemetryInstallState();
  const state = current ?? createTelemetryInstallState();

  if (state.firstRunCapturedAt || state.firstRunSkippedAt) {
    return state;
  }

  const now = new Date().toISOString();
  const updated: TelemetryInstallState = {
    ...state,
    ...(disposition === 'captured'
      ? { firstRunCapturedAt: now }
      : {
        firstRunSkippedAt: now,
        firstRunSkipReason: options.skipReason ?? 'unknown',
      }),
  };
  await writeTelemetryInstallState(updated);
  return updated;
}

export async function readTelemetryInstallState(): Promise<TelemetryInstallState | null> {
  try {
    const raw = await fsp.readFile(getTelemetryStatePath(), 'utf8');
    return normalizeTelemetryInstallState(JSON.parse(raw));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    return null;
  }
}

function createTelemetryInstallState(): TelemetryInstallState {
  return {
    installId: randomUUID(),
    firstRunCapturedAt: null,
    firstRunSkippedAt: null,
    firstRunSkipReason: null,
  };
}

function normalizeTelemetryInstallState(raw: unknown): TelemetryInstallState | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Partial<Record<keyof TelemetryInstallState, unknown>>;
  if (typeof value.installId !== 'string' || value.installId.trim().length === 0) {
    return null;
  }

  return {
    installId: value.installId,
    firstRunCapturedAt: typeof value.firstRunCapturedAt === 'string'
      ? value.firstRunCapturedAt
      : null,
    firstRunSkippedAt: typeof value.firstRunSkippedAt === 'string'
      ? value.firstRunSkippedAt
      : null,
    firstRunSkipReason: normalizeFirstRunSkipReason(value.firstRunSkipReason),
  };
}

function normalizeFirstRunSkipReason(value: unknown): FirstRunSkipReason | null {
  if (
    value === 'client_disabled'
    || value === 'existing_install_data'
    || value === 'telemetry_disabled_by_env'
    || value === 'unknown'
  ) {
    return value;
  }
  return null;
}

async function writeTelemetryInstallState(state: TelemetryInstallState): Promise<void> {
  const filePath = getTelemetryStatePath();
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, `${JSON.stringify(state, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
}

function getTelemetryStatePath(): string {
  return getTesseraDataPath(TELEMETRY_STATE_FILE);
}

function hasExistingInstallData(): boolean {
  const dataDir = getTesseraDataDir();
  for (const marker of EXISTING_INSTALL_MARKERS) {
    if (fs.existsSync(path.join(dataDir, marker))) {
      return true;
    }
  }
  return false;
}
