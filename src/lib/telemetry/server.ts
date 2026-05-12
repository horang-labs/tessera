import type { NextRequest } from 'next/server';
import { getServerHostInfo } from '@/lib/system/server-host';
import { getTelemetryBootstrapInfo } from './server-state';
import logger from '@/lib/logger';

export type ServerTelemetryEventName =
  | 'setup_cli_detection_summary'
  | 'setup_cli_provider_status'
  | 'setup_cli_smoke_provider_result'
  | 'setup_cli_smoke_raw_log'
  | 'setup_cli_smoke_run_completed'
  | 'settings_cli_diagnostics_provider_result'
  | 'settings_cli_diagnostics_raw_log'
  | 'settings_cli_diagnostics_run_completed';

export type ServerTelemetryProperties = Record<string, unknown>;

const MAX_STRING_LENGTH = 100;
const MAX_ERROR_MESSAGE_LENGTH = 1_000;
const MAX_ARRAY_LENGTH = 30;
const MAX_RAW_LOG_JSONL_LENGTH = 512 * 1024;
const MAX_SMOKE_TRACE_JSONL_LENGTH = 32 * 1024;
const CAPTURE_TIMEOUT_MS = 2_000;

const allowedEvents = new Set<ServerTelemetryEventName>([
  'setup_cli_detection_summary',
  'setup_cli_provider_status',
  'setup_cli_smoke_provider_result',
  'setup_cli_smoke_raw_log',
  'setup_cli_smoke_run_completed',
  'settings_cli_diagnostics_provider_result',
  'settings_cli_diagnostics_raw_log',
  'settings_cli_diagnostics_run_completed',
]);

export function isServerTelemetryCaptureAllowed(request?: NextRequest): boolean {
  const hostInfo = getServerHostInfo();
  return Boolean(
    process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN
      && !hostInfo.telemetryDisabledByEnv
      && !isRequestPrivacyOptOut(request),
  );
}

export async function captureServerTelemetryEvent(
  eventName: ServerTelemetryEventName,
  properties: ServerTelemetryProperties = {},
  request?: NextRequest,
): Promise<void> {
  if (!allowedEvents.has(eventName) || !isServerTelemetryCaptureAllowed(request)) {
    return;
  }

  const projectToken = process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN;
  if (!projectToken) return;

  const hostInfo = getServerHostInfo();
  const bootstrap = await getTelemetryBootstrapInfo(hostInfo);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CAPTURE_TIMEOUT_MS);

  try {
    const response = await fetch(`${getPostHogCaptureHost()}/capture/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: projectToken,
        event: eventName,
        properties: {
          distinct_id: bootstrap.installId,
          install_id: bootstrap.installId,
          app_version: hostInfo.appVersion,
          platform: hostInfo.platform,
          arch: hostInfo.arch,
          channel: hostInfo.channel,
          $geoip_disable: true,
          $process_person_profile: false,
          ...sanitizeTelemetryProperties(properties),
        },
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      logger.warn({ eventName, status: response.status }, 'server telemetry capture failed');
    }
  } catch (error) {
    logger.warn({ eventName, error }, 'server telemetry capture error');
  } finally {
    clearTimeout(timeout);
  }
}

function getPostHogCaptureHost(): string {
  const explicitHost = process.env.NEXT_PUBLIC_POSTHOG_HOST;
  if (explicitHost) return explicitHost.replace(/\/$/, '');

  const apiHost = process.env.NEXT_PUBLIC_POSTHOG_API_HOST;
  if (apiHost?.startsWith('http://') || apiHost?.startsWith('https://')) {
    return apiHost.replace(/\/$/, '');
  }

  return 'https://us.i.posthog.com';
}

function isRequestPrivacyOptOut(request?: NextRequest): boolean {
  if (!request) return false;
  const dnt = request.headers.get('dnt') || request.headers.get('DNT');
  const gpc = request.headers.get('sec-gpc') || request.headers.get('Sec-GPC');
  return dnt === '1' || dnt === 'yes' || gpc === '1';
}

function sanitizeTelemetryProperties(
  properties: ServerTelemetryProperties,
): ServerTelemetryProperties {
  const sanitized: ServerTelemetryProperties = {};

  for (const [key, value] of Object.entries(properties)) {
    if (typeof value === 'string') {
      sanitized[key] = value.slice(
        0,
        getMaxStringLengthForProperty(key),
      );
      continue;
    }

    if (typeof value === 'number') {
      if (Number.isFinite(value)) sanitized[key] = value;
      continue;
    }

    if (typeof value === 'boolean') {
      sanitized[key] = value;
      continue;
    }

    if (Array.isArray(value)) {
      sanitized[key] = value
        .filter((item): item is string => typeof item === 'string')
        .slice(0, MAX_ARRAY_LENGTH)
        .map((item) => item.slice(0, MAX_STRING_LENGTH));
    }
  }

  return sanitized;
}

function getMaxStringLengthForProperty(key: string): number {
  if (key === 'raw_log_jsonl') return MAX_RAW_LOG_JSONL_LENGTH;
  if (key === 'smoke_trace_jsonl') return MAX_SMOKE_TRACE_JSONL_LENGTH;
  if (key.endsWith('_error_message')) return MAX_ERROR_MESSAGE_LENGTH;
  return MAX_STRING_LENGTH;
}
