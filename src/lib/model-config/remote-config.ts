import fsp from 'fs/promises';
import { rmSync } from 'fs';
import path from 'path';
import { getServerHostInfo } from '@/lib/system/server-host';
import type { ServerHostInfo } from '@/lib/system/types';
import { getTelemetryBootstrapInfo } from '@/lib/telemetry/server-state';
import { getTesseraDataPath } from '@/lib/tessera-data-dir';
import logger from '@/lib/logger';
import type {
  ProviderModelOption,
  ProviderReasoningEffortOption,
} from '@/lib/cli/provider-session-option-types';

// Fetches the Claude model list from the remote Worker, caches it on disk, and exposes
// it to buildClaudeSessionOptions(). The Worker config is the SINGLE source of truth —
// there is no hardcoded model list; getClaudeModelOptions() returns the loaded list (or
// [] until one arrives).
//
// There is no periodic poll. The config is fetched on exactly two triggers — app launch
// and each Claude session creation — and every fetch doubles as a usage beacon (the
// Worker counts arrivals): X-Tessera-Event says which trigger it was, and a random
// install_id + host info ride along unconditionally — no gating, no PII.

const CACHE_FILE = 'model-config.json';
const FETCH_TIMEOUT_MS = 10_000;
const MAX_MODELS = 50;
const MAX_EFFORTS = 16;
const DEFAULT_CONFIG_URL = 'https://tessera-model-config.faggomsa.workers.dev/v1/model-config';

function getConfigUrl(): string {
  return process.env.TESSERA_MODEL_CONFIG_URL?.trim() || DEFAULT_CONFIG_URL;
}

export interface CachedModelConfig {
  version: number;
  etag: string | null;
  models: ProviderModelOption[];
  fetchedAt: string;
}

/** What triggered a config fetch — the Worker records it as the usage-count dimension. */
export type ModelConfigFetchReason = 'launch' | 'session';

let activeConfig: CachedModelConfig | null = null;
let diskLoadPromise: Promise<void> | null = null;
let inFlightRefresh: Promise<{ changed: boolean }> | null = null;

// ── normalization (remote input is untrusted → coerce into strict option shapes) ──

function toTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeEffort(raw: unknown): ProviderReasoningEffortOption | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const value = toTrimmedString(r.value);
  const label = toTrimmedString(r.label);
  if (!value || !label) return null;
  const effort: ProviderReasoningEffortOption = {
    value,
    label,
    description: typeof r.description === 'string' ? r.description : '',
  };
  // Whether a level is spawn-only is a property of the CLI integration, not the
  // remote catalog: `max` exists only as the --effort flag (the apply_flag_settings
  // effortLevel enum stops at xhigh), so it can't change on a live process. Stamp
  // it here, letting the Worker override if it ever starts sending the field.
  if (typeof r.requiresRestart === 'boolean') {
    effort.requiresRestart = r.requiresRestart;
  } else if (value === 'max') {
    effort.requiresRestart = true;
  }
  return effort;
}

function normalizeEfforts(raw: unknown): ProviderReasoningEffortOption[] | null {
  if (!Array.isArray(raw) || raw.length > MAX_EFFORTS) return null;
  const out: ProviderReasoningEffortOption[] = [];
  for (const item of raw) {
    const effort = normalizeEffort(item);
    if (!effort) return null;
    out.push(effort);
  }
  return out;
}

function normalizeModel(raw: unknown): ProviderModelOption | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const value = toTrimmedString(r.value);
  const label = toTrimmedString(r.label);
  if (!value || !label) return null;
  const efforts = normalizeEfforts(r.supportedReasoningEfforts);
  if (efforts === null) return null;

  const model: ProviderModelOption = {
    value,
    label,
    isDefault: r.isDefault === true,
    supportedReasoningEfforts: efforts,
  };
  if (typeof r.description === 'string') model.description = r.description;
  if (typeof r.defaultReasoningEffort === 'string' || r.defaultReasoningEffort === null) {
    model.defaultReasoningEffort = r.defaultReasoningEffort as string | null;
  }
  if (typeof r.supportsFastMode === 'boolean') model.supportsFastMode = r.supportsFastMode;
  return model;
}

function normalizeModels(raw: unknown): ProviderModelOption[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_MODELS) return null;
  const out: ProviderModelOption[] = [];
  let defaults = 0;
  for (const item of raw) {
    const model = normalizeModel(item);
    if (!model) return null;
    if (model.isDefault) defaults += 1;
    out.push(model);
  }
  if (defaults > 1) return null;
  return out;
}

/** Parse the Worker response document: { version, providers: { 'claude-code': { models } } }. */
export function extractClaudeModels(
  raw: unknown,
): { version: number; models: ProviderModelOption[] } | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const version =
    typeof r.version === 'number' && Number.isInteger(r.version) ? r.version : null;
  if (version === null) return null;
  const providers = r.providers;
  if (!providers || typeof providers !== 'object') return null;
  const claude = (providers as Record<string, unknown>)['claude-code'];
  if (!claude || typeof claude !== 'object') return null;
  const models = normalizeModels((claude as Record<string, unknown>).models);
  if (!models) return null;
  return { version, models };
}

/** Parse our own on-disk cache record: { version, etag, models, fetchedAt }. */
function normalizeCacheRecord(raw: unknown): CachedModelConfig | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const version = typeof r.version === 'number' ? r.version : null;
  if (version === null) return null;
  const models = normalizeModels(r.models);
  if (!models) return null;
  return {
    version,
    etag: typeof r.etag === 'string' ? r.etag : null,
    models,
    fetchedAt: typeof r.fetchedAt === 'string' ? r.fetchedAt : new Date().toISOString(),
  };
}

// ── disk cache (atomic write, mirrors settings/manager + telemetry/server-state) ──

function getCachePath(): string {
  return getTesseraDataPath(CACHE_FILE);
}

async function readDiskCache(): Promise<CachedModelConfig | null> {
  try {
    const raw = await fsp.readFile(getCachePath(), 'utf8');
    return normalizeCacheRecord(JSON.parse(raw));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    logger.warn({ error }, 'model-config: disk cache read failed');
    return null;
  }
}

async function writeDiskCache(config: CachedModelConfig): Promise<void> {
  const filePath = getCachePath();
  const dir = path.dirname(filePath);
  await fsp.mkdir(dir, { recursive: true });
  const tempPath = path.join(dir, `.${CACHE_FILE}.${process.pid}.${Date.now()}.tmp`);
  try {
    await fsp.writeFile(tempPath, `${JSON.stringify(config, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    await fsp.rename(tempPath, filePath);
  } catch (error) {
    await fsp.unlink(tempPath).catch(() => undefined);
    throw error;
  }
}

// ── public API ──

/** Sync read used by buildClaudeSessionOptions(). Empty until a config has loaded. */
export function getClaudeModelOptions(): ProviderModelOption[] {
  return activeConfig?.models ?? [];
}

/** Idempotent: load the disk cache into the store once. No network. */
export function ensureRemoteModelConfigLoaded(): Promise<void> {
  if (!diskLoadPromise) {
    diskLoadPromise = readDiskCache()
      .then((disk) => {
        // Don't clobber a fresher config already set by a concurrent refresh.
        if (disk && !activeConfig) activeConfig = disk;
      })
      .catch((error) => {
        logger.warn({ error }, 'model-config: disk cache load failed');
      });
  }
  return diskLoadPromise;
}

/**
 * Ensure a model list is ready to serve. Loads the disk cache (instant first paint) and,
 * if a launch/session refresh is in flight right now, awaits it so the options built next
 * reflect it. If there is no config at all (first run whose launch fetch failed, or a
 * wiped cache), retries the fetch here — still labeled 'launch', since the failed launch
 * was never counted. Once a config exists this never touches the network: freshness is
 * owned entirely by the launch/session triggers.
 */
export async function ensureModelConfigReady(): Promise<void> {
  await ensureRemoteModelConfigLoaded();
  if (inFlightRefresh) {
    await inFlightRefresh;
    return;
  }
  if (!activeConfig) {
    await refreshRemoteModelConfig('launch');
  }
}

async function buildRequestHeaders(
  hostInfo: ServerHostInfo,
  reason: ModelConfigFetchReason,
): Promise<Record<string, string>> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'User-Agent': 'Tessera model-config fetcher',
    'X-Tessera-Event': reason,
    'X-Tessera-Version': hostInfo.appVersion,
    'X-Tessera-Platform': String(hostInfo.platform),
    'X-Tessera-Arch': String(hostInfo.arch),
    'X-Tessera-Channel': hostInfo.channel,
  };
  // install_id is a random UUID (never PII); it's what lets the Worker de-dupe launches
  // into unique installs. Sent unconditionally — the config fetch IS the launch count.
  try {
    const bootstrap = await getTelemetryBootstrapInfo(hostInfo);
    if (bootstrap.installId) {
      headers['X-Tessera-Install-Id'] = bootstrap.installId;
    }
  } catch (error) {
    logger.warn({ error }, 'model-config: install id unavailable');
  }
  return headers;
}

/**
 * Network refresh + usage beacon (`reason` = what triggered it). Returns whether the
 * active model list changed. Never rejects — all failures resolve to { changed: false }.
 * Deliberately NOT de-duplicated: every call is one beacon event, so a session created
 * while the launch fetch is still in flight must still send its own request.
 */
export function refreshRemoteModelConfig(
  reason: ModelConfigFetchReason,
  deps: { fetchImpl?: typeof fetch; hostInfo?: ServerHostInfo } = {},
): Promise<{ changed: boolean }> {
  const promise = doRefresh(reason, deps);
  inFlightRefresh = promise;
  void promise.finally(() => {
    if (inFlightRefresh === promise) inFlightRefresh = null;
  });
  return promise;
}

async function doRefresh(
  reason: ModelConfigFetchReason,
  deps: { fetchImpl?: typeof fetch; hostInfo?: ServerHostInfo },
): Promise<{ changed: boolean }> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const hostInfo = deps.hostInfo ?? getServerHostInfo();
  await ensureRemoteModelConfigLoaded();

  const headers = await buildRequestHeaders(hostInfo, reason);
  if (activeConfig?.etag) headers['If-None-Match'] = activeConfig.etag;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetchImpl(getConfigUrl(), {
      cache: 'no-store',
      headers,
      signal: controller.signal,
    });

    if (response.status === 304) return { changed: false };
    if (!response.ok) {
      logger.warn({ status: response.status }, 'model-config: refresh returned non-ok status');
      return { changed: false };
    }

    const extracted = extractClaudeModels(await response.json());
    if (!extracted) {
      logger.warn('model-config: refresh payload invalid, keeping current list');
      return { changed: false };
    }

    const etag = response.headers.get('etag');
    const changed =
      !activeConfig || activeConfig.etag !== etag || activeConfig.version !== extracted.version;

    activeConfig = {
      version: extracted.version,
      etag,
      models: extracted.models,
      fetchedAt: new Date().toISOString(),
    };
    await writeDiskCache(activeConfig).catch((error) => {
      logger.warn({ error }, 'model-config: disk cache write failed');
    });

    return { changed };
  } catch (error) {
    logger.warn({ error }, 'model-config: refresh error, keeping current list');
    return { changed: false };
  } finally {
    clearTimeout(timeout);
  }
}

/** Test-only: reset module state between cases. */
export function __resetRemoteModelConfigForTests(): void {
  activeConfig = null;
  diskLoadPromise = null;
  inFlightRefresh = null;
  rmSync(getCachePath(), { force: true });
}
