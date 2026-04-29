import { readFile } from 'fs/promises';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { join } from 'path';
import { homedir, userInfo } from 'os';
import logger from '../logger';

const execFileAsync = promisify(execFile);

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

const CREDENTIALS_PATH = join(homedir(), '.claude', '.credentials.json');
const CACHE_TTL_MS = 300_000; // 5 minutes

let cachedData: RateLimitData | null = null;
let cachedAt = 0;

// In-memory token override (after refresh)
let accessTokenOverride: string | null = null;

async function readFromKeychain(): Promise<OAuthCredentials> {
  const account = userInfo().username;
  const { stdout } = await execFileAsync('security', [
    'find-generic-password',
    '-s', 'Claude Code-credentials',
    '-a', account,
    '-w',
  ]);
  return JSON.parse(stdout.trim());
}

async function readCredentials(): Promise<OAuthCredentials | null> {
  try {
    if (process.platform === 'darwin') {
      return await readFromKeychain();
    }
    const raw = await readFile(CREDENTIALS_PATH, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function getAccessToken(): Promise<string | null> {
  if (accessTokenOverride) return accessTokenOverride;
  const creds = await readCredentials();
  return creds?.claudeAiOauth?.accessToken ?? null;
}

async function refreshAccessToken(): Promise<string | null> {
  const creds = await readCredentials();
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
    accessTokenOverride = data.access_token;
    return accessTokenOverride;
  } catch (err) {
    logger.error({ error: err }, 'Token refresh error');
    return null;
  }
}

async function fetchUsage(token: string): Promise<UsageApiResponse | null> {
  try {
    const res = await fetch('https://api.anthropic.com/api/oauth/usage', {
      headers: {
        Authorization: `Bearer ${token}`,
        'anthropic-beta': 'oauth-2025-04-20',
      },
    });

    if (res.status === 401) {
      // Try refresh
      const newToken = await refreshAccessToken();
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

export async function getRateLimitData(): Promise<RateLimitData | null> {
  const now = Date.now();
  if (cachedData && now - cachedAt < CACHE_TTL_MS) {
    return cachedData;
  }

  const token = await getAccessToken();
  if (!token) return null;

  const usage = await fetchUsage(token);
  if (!usage) return null;

  const parsed = parseUsageResponse(usage);
  if (parsed) {
    cachedData = parsed;
    cachedAt = now;
  }

  return parsed;
}

export function getCachedRateLimitData(): RateLimitData | null {
  return cachedData;
}

export async function hasOAuthCredentials(): Promise<boolean> {
  const creds = await readCredentials();
  return !!creds?.claudeAiOauth?.accessToken;
}
