import { execFile } from 'child_process';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { homedir, userInfo } from 'os';
import { isRunningInWsl, type CliEnvironment } from '../cli/cli-exec';
import { getRuntimePlatform } from '../system/runtime-platform';
import logger from '../logger';
import { RATE_LIMIT_REFRESH_INTERVAL_MS } from './constants';

interface OAuthCredentials {
  claudeAiOauth?: {
    accessToken: string;
    refreshToken: string;
    expiresAt: string;
  };
}

interface UsageTierRaw {
  utilization: number;  // 0-100
  resets_at: string | null;
}

interface UsageApiResponse {
  five_hour: UsageTierRaw | null;
  seven_day: UsageTierRaw | null;
  seven_day_opus?: UsageTierRaw | null;
  seven_day_oauth_apps?: UsageTierRaw | null;
}

export interface RateLimitData {
  fiveHour: { utilization: number; resetsAt: string };
  sevenDay: { utilization: number; resetsAt: string };
}

interface RateLimitFetchOptions {
  environment?: CliEnvironment;
}

interface CacheEntry {
  data: RateLimitData;
  cachedAt: number;
}

const KEYCHAIN_SERVICE = 'Claude Code-credentials';
const CREDENTIALS_FILE = '.credentials.json';
const CACHE_TTL_MS = RATE_LIMIT_REFRESH_INTERVAL_MS;
const CREDENTIALS_READ_TIMEOUT_MS = 5_000;

const cachedDataByEnvironment = new Map<CliEnvironment, CacheEntry>();

// In-memory token override (after refresh)
const accessTokenOverrideByEnvironment = new Map<CliEnvironment, string>();

function getClaudeConfigDir(): string {
  const configuredDir = process.env.CLAUDE_CONFIG_DIR?.trim();
  return configuredDir || join(homedir(), '.claude');
}

function credentialsPath(): string {
  return join(getClaudeConfigDir(), CREDENTIALS_FILE);
}

function parseCredentials(raw: string): OAuthCredentials | null {
  const trimmed = raw.trim().replace(/^\uFEFF/, '');
  if (!trimmed) return null;

  try {
    return JSON.parse(trimmed) as OAuthCredentials;
  } catch (err) {
    logger.warn({ error: err }, 'Failed to parse Claude credentials');
    return null;
  }
}

function execFileStdout(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, {
      encoding: 'utf8',
      timeout: CREDENTIALS_READ_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    }, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }

      resolve(stdout);
    });
  });
}

async function readLocalCredentialsFile(): Promise<OAuthCredentials | null> {
  const raw = await readFile(credentialsPath(), 'utf-8');
  return parseCredentials(raw);
}

async function readFromMacKeychain(): Promise<OAuthCredentials | null> {
  const account = userInfo().username;
  const attempts = [
    ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', account, '-w'],
    ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-w'],
  ];

  for (const args of attempts) {
    try {
      const raw = await execFileStdout('/usr/bin/security', args);
      const creds = parseCredentials(raw);
      if (creds) return creds;
    } catch {
      // Try the next keychain lookup form, then fall back to the file backend.
    }
  }

  return null;
}

async function readWslCredentialsFile(): Promise<OAuthCredentials | null> {
  if (getRuntimePlatform() !== 'win32') {
    return readLocalCredentialsFile();
  }

  const raw = await execFileStdout('wsl', [
    'bash',
    '-lc',
    'cat "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/.credentials.json"',
  ]);
  return parseCredentials(raw);
}

async function readWindowsHostCredentialsFile(): Promise<OAuthCredentials | null> {
  const raw = await execFileStdout('cmd.exe', [
    '/d',
    '/s',
    '/c',
    'type "%USERPROFILE%\\.claude\\.credentials.json"',
  ]);
  return parseCredentials(raw);
}

async function readNativeCredentials(): Promise<OAuthCredentials | null> {
  if (isRunningInWsl()) {
    try {
      return await readWindowsHostCredentialsFile();
    } catch {
      return null;
    }
  }

  if (getRuntimePlatform() === 'darwin') {
    const keychainCredentials = await readFromMacKeychain();
    if (keychainCredentials) return keychainCredentials;
  }

  return readLocalCredentialsFile();
}

async function readCredentials(environment: CliEnvironment): Promise<OAuthCredentials | null> {
  try {
    return environment === 'wsl'
      ? await readWslCredentialsFile()
      : await readNativeCredentials();
  } catch {
    return null;
  }
}

async function getAccessToken(environment: CliEnvironment): Promise<string | null> {
  const override = accessTokenOverrideByEnvironment.get(environment);
  if (override) return override;

  const creds = await readCredentials(environment);
  return creds?.claudeAiOauth?.accessToken ?? null;
}

async function refreshAccessToken(environment: CliEnvironment): Promise<string | null> {
  const creds = await readCredentials(environment);
  const refreshToken = creds?.claudeAiOauth?.refreshToken;
  if (!refreshToken) return null;

  try {
    const res = await fetch('https://console.anthropic.com/v1/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      }),
    });

    if (!res.ok) {
      logger.error({ status: res.status }, 'Token refresh failed');
      return null;
    }

    const data = await res.json();
    const accessToken = typeof data.access_token === 'string' ? data.access_token : null;
    if (accessToken) {
      accessTokenOverrideByEnvironment.set(environment, accessToken);
    }
    return accessToken;
  } catch (err) {
    logger.error({ error: err }, 'Token refresh error');
    return null;
  }
}

async function fetchUsage(token: string, environment: CliEnvironment): Promise<UsageApiResponse | null> {
  try {
    const res = await fetch('https://api.anthropic.com/api/oauth/usage', {
      headers: {
        Authorization: `Bearer ${token}`,
        'anthropic-beta': 'oauth-2025-04-20',
      },
    });

    if (res.status === 401) {
      // Try refresh
      const newToken = await refreshAccessToken(environment);
      if (!newToken) return null;

      const retryRes = await fetch('https://api.anthropic.com/api/oauth/usage', {
        headers: {
          Authorization: `Bearer ${newToken}`,
          'anthropic-beta': 'oauth-2025-04-20',
        },
      });

      if (!retryRes.ok) return null;
      return retryRes.json();
    }

    if (!res.ok) return null;
    return res.json();
  } catch (err) {
    logger.error({ error: err }, 'Usage API fetch error');
    return null;
  }
}

function parseUsageResponse(data: UsageApiResponse): RateLimitData | null {
  if (!data.five_hour && !data.seven_day) return null;

  return {
    fiveHour: {
      utilization: data.five_hour?.utilization ?? 0,
      resetsAt: data.five_hour?.resets_at ?? '',
    },
    sevenDay: {
      utilization: data.seven_day?.utilization ?? 0,
      resetsAt: data.seven_day?.resets_at ?? '',
    },
  };
}

export async function getRateLimitData(options: RateLimitFetchOptions = {}): Promise<RateLimitData | null> {
  const environment = options.environment ?? 'native';
  const now = Date.now();
  const cached = cachedDataByEnvironment.get(environment);
  if (cached && now - cached.cachedAt < CACHE_TTL_MS) {
    return cached.data;
  }

  const token = await getAccessToken(environment);
  if (!token) return null;

  const usage = await fetchUsage(token, environment);
  if (!usage) return null;

  const parsed = parseUsageResponse(usage);
  if (parsed) {
    cachedDataByEnvironment.set(environment, { data: parsed, cachedAt: now });
  }

  return parsed;
}

export function getCachedRateLimitData(environment?: CliEnvironment): RateLimitData | null {
  if (environment) {
    return cachedDataByEnvironment.get(environment)?.data ?? null;
  }

  let latest: CacheEntry | null = null;
  for (const entry of cachedDataByEnvironment.values()) {
    if (!latest || entry.cachedAt > latest.cachedAt) {
      latest = entry;
    }
  }

  return latest?.data ?? null;
}

export async function hasOAuthCredentials(options: RateLimitFetchOptions = {}): Promise<boolean> {
  const creds = await readCredentials(options.environment ?? 'native');
  return !!creds?.claudeAiOauth?.accessToken;
}
