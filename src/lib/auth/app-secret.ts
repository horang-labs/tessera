import { randomBytes, timingSafeEqual } from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { getTesseraDataPath } from '../tessera-data-dir';

const APP_SECRET_BYTES = 32;
const APP_SECRET_LENGTH = 43;
const APP_SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export const APP_SECRET_HEADER = 'x-tessera-app-secret';
export const APP_SECRET_PATH = getTesseraDataPath('auth', 'app-secret');

let cachedSecret: string | null = null;
let cachedMtimeMs: number | null = null;

function isAppSecret(value: string): boolean {
  return value.length === APP_SECRET_LENGTH && APP_SECRET_PATTERN.test(value);
}

async function cacheStoredSecret(): Promise<string | null> {
  try {
    const fileStat = await fs.stat(APP_SECRET_PATH);
    if (cachedSecret && cachedMtimeMs === fileStat.mtimeMs) {
      return cachedSecret;
    }

    const stored = (await fs.readFile(APP_SECRET_PATH, 'utf8')).trim();
    if (!isAppSecret(stored)) return null;

    cachedSecret = stored;
    cachedMtimeMs = fileStat.mtimeMs;
    return stored;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export async function ensureAppSecret(): Promise<string> {
  const existing = await cacheStoredSecret();
  if (existing) {
    await fs.chmod(APP_SECRET_PATH, 0o600);
    return existing;
  }

  const directory = path.dirname(APP_SECRET_PATH);
  const temporaryPath = path.join(
    directory,
    `.app-secret.${process.pid}.${Date.now()}.tmp`,
  );
  const secret = randomBytes(APP_SECRET_BYTES).toString('base64url');

  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  try {
    await fs.writeFile(temporaryPath, `${secret}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    await fs.rename(temporaryPath, APP_SECRET_PATH);
    await fs.chmod(APP_SECRET_PATH, 0o600);
  } catch (error) {
    await fs.unlink(temporaryPath).catch(() => undefined);
    throw error;
  }

  const fileStat = await fs.stat(APP_SECRET_PATH);
  cachedSecret = secret;
  cachedMtimeMs = fileStat.mtimeMs;
  return secret;
}

export async function matchesAppSecret(candidate: string | undefined): Promise<boolean> {
  if (!candidate || !isAppSecret(candidate)) return false;

  const secret = await cacheStoredSecret();
  if (!secret) return false;

  return timingSafeEqual(Buffer.from(candidate), Buffer.from(secret));
}
