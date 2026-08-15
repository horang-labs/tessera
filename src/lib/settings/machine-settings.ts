import fs from 'node:fs/promises';
import path from 'node:path';
import {
  normalizeAdvertisedAddress,
  type AdvertisedAddress,
} from '../auth/advertised-address';
import logger from '../logger';
import { getTesseraDataPath } from '../tessera-data-dir';

export interface MachineSettings {
  advertisedAddress: string | null;
}

export const MACHINE_SETTINGS_PATH = getTesseraDataPath('remote-access.json');

const DEFAULT_MACHINE_SETTINGS: MachineSettings = {
  advertisedAddress: null,
};

function toMachineSettings(address: AdvertisedAddress | null): MachineSettings {
  return {
    advertisedAddress: address?.pairingBaseUrl ?? null,
  };
}

export async function loadMachineSettings(): Promise<MachineSettings> {
  try {
    const raw = JSON.parse(await fs.readFile(MACHINE_SETTINGS_PATH, 'utf8')) as {
      advertisedAddress?: unknown;
    };
    return toMachineSettings(normalizeAdvertisedAddress(raw.advertisedAddress ?? ''));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return DEFAULT_MACHINE_SETTINGS;
    }
    logger.warn({ error }, 'Failed to load machine settings');
    return DEFAULT_MACHINE_SETTINGS;
  }
}

export async function saveMachineSettings(input: {
  advertisedAddress: unknown;
}): Promise<MachineSettings> {
  const settings = toMachineSettings(normalizeAdvertisedAddress(input.advertisedAddress));
  const settingsDir = path.dirname(MACHINE_SETTINGS_PATH);
  const tempPath = path.join(
    settingsDir,
    `.remote-access.${process.pid}.${Date.now()}.tmp`,
  );

  await fs.mkdir(settingsDir, { recursive: true, mode: 0o700 });
  try {
    await fs.writeFile(tempPath, JSON.stringify(settings, null, 2), {
      encoding: 'utf8',
      mode: 0o600,
    });
    await fs.rename(tempPath, MACHINE_SETTINGS_PATH);
  } catch (error) {
    await fs.unlink(tempPath).catch(() => undefined);
    throw error;
  }

  logger.info({ advertisedAddress: settings.advertisedAddress }, 'Machine settings saved');
  return settings;
}
