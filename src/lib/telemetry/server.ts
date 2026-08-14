import type { NextRequest } from 'next/server';
import { getServerHostInfo } from '@/lib/system/server-host';
import { getTelemetryBootstrapInfo } from './server-state';
import type { TelemetryBootstrapInfo } from './server-state';
import logger from '@/lib/logger';
import { isSensitiveTelemetryPropertyName } from './privacy';

export type ServerTelemetryEventName =
  | 'setup_cli_detection_summary'
  | 'setup_cli_provider_status'
  | 'setup_cli_smoke_provider_result'
  | 'setup_cli_smoke_raw_log'
  | 'setup_cli_smoke_run_completed'
  | 'settings_cli_diagnostics_provider_result'
  | 'settings_cli_diagnostics_raw_log'
  | 'settings_cli_diagnostics_run_completed'
  | 'ai_title_generation_result';

export type ServerTelemetryProperties = Record<string, unknown>;

const MAX_STRING_LENGTH = 100;
const MAX_ARRAY_LENGTH = 30;
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
  'ai_title_generation_result',
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
          first_run_eligible: bootstrap.firstRunEligible,
          first_run_status: getFirstRunStatus(bootstrap),
          ...(bootstrap.firstRunSkipReason
            ? { first_run_skip_reason: bootstrap.firstRunSkipReason }
            : {}),
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

function getFirstRunStatus(bootstrap: TelemetryBootstrapInfo): string {
  if (bootstrap.firstRunCapturedAt) return 'captured';
  if (bootstrap.firstRunSkippedAt) return 'skipped';
  if (bootstrap.firstRunEligible) return 'eligible';
  return 'unknown';
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
    if (isSensitiveTelemetryPropertyName(key)) continue;

    if (typeof value === 'string') {
      sanitized[key] = value.slice(0, MAX_STRING_LENGTH);
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
