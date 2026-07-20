import type { CaptureOptions, CaptureResult, PostHogConfig } from 'posthog-js';
import type { ServerHostInfo } from '@/lib/system/types';

export type TelemetryEventName =
  | 'first_run_started'
  | 'app_started'
  | 'app_usage_heartbeat'
  | 'agent_session_started'
  | 'agent_usage_heartbeat'
  | 'session_created'
  | 'task_created'
  | 'workspace_view_changed'
  | 'provider_setup_issue_seen'
  | 'project_import_result'
  | 'git_panel_opened'
  | 'git_panel_tab_changed'
  | 'git_file_opened'
  | 'git_action_triggered'
  | 'provider_selected'
  | 'telemetry_opt_out';

export type TelemetryOptOutSource = 'setup' | 'settings';
export type TelemetryProviderSetupIssueStatus = 'missing' | 'needs_login' | 'unavailable';

export type TelemetryEventProperties = Record<string, unknown>;
type TelemetryCaptureOptions = Pick<CaptureOptions, 'send_instantly' | 'transport'>;
export type TelemetryFirstRunCaptureResult = 'captured' | 'disabled' | 'failed';

export interface TelemetryRuntimeContext {
  installId: string;
  appSessionId: string;
  appVersion: string;
  platform: ServerHostInfo['platform'];
  arch: ServerHostInfo['arch'];
  channel: string;
}

const MAX_STRING_LENGTH = 100;
const MAX_ARRAY_LENGTH = 20;

const projectToken = process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN;
const apiHost = process.env.NEXT_PUBLIC_POSTHOG_API_HOST || '/ingest';
const uiHost = process.env.NEXT_PUBLIC_POSTHOG_UI_HOST || 'https://us.posthog.com';

const allowedEvents = new Set<TelemetryEventName>([
  'first_run_started',
  'app_started',
  'app_usage_heartbeat',
  'agent_session_started',
  'agent_usage_heartbeat',
  'session_created',
  'task_created',
  'workspace_view_changed',
  'provider_setup_issue_seen',
  'project_import_result',
  'git_panel_opened',
  'git_panel_tab_changed',
  'git_file_opened',
  'git_action_triggered',
  'provider_selected',
  'telemetry_opt_out',
]);

const allowedProperties = new Set([
  '$geoip_disable',
  '$process_person_profile',
  'active_seconds',
  'app_session_id',
  'app_version',
  'arch',
  'channel',
  'distinct_id',
  'environment',
  'error_code',
  'file_state',
  'changed_file_count',
  'github_available',
  'has_collection',
  'has_changes',
  'has_pr',
  'is_git_repo',
  'has_task',
  'has_worktree',
  'install_id',
  'platform',
  'provider_id',
  'result',
  'source',
  'status',
  'tab',
  'target',
  'view',
  'action',
]);

const allowedSources = new Set([
  'setup',
  'settings',
  'new_session',
  'kanban',
  'list',
  'project_import',
  'git_panel',
]);
const allowedViews = new Set(['list', 'kanban']);
const allowedGitTabs = new Set(['git', 'files', 'memory']);
const allowedGitActions = new Set([
  'commit',
  'fetch',
  'push',
  'pull',
  'merge',
  'create_pr',
  'merge_pr',
  'copy_branch',
  'copy_worktree_path',
  'open_external',
  'preview_diff',
  'open_diff_tab',
  'open_file_tab',
]);
const allowedGitTargets = new Set([
  'repository',
  'pull_request',
  'checks',
  'branch',
  'worktree_path',
  'diff',
  'file',
  'unknown',
]);
const allowedGitFileStates = new Set([
  'modified',
  'added',
  'deleted',
  'renamed',
  'copied',
  'untracked',
  'conflicted',
  'typechange',
  'unknown',
]);
const allowedProviderIssueStatuses = new Set<TelemetryProviderSetupIssueStatus>([
  'missing',
  'needs_login',
  'unavailable',
]);
const allowedProjectImportResults = new Set(['success', 'failed']);
const allowedProjectImportErrorCodes = new Set([
  'environment_mismatch',
  'permission_denied',
  'missing_folder',
  'invalid_folder',
  'unknown',
]);
const allowedEnvironments = new Set(['native', 'wsl']);

let telemetryContext: TelemetryRuntimeContext | null = null;
let telemetryEnabled = false;
let posthogClient: PostHogClient | null = null;
let posthogPromise: Promise<PostHogClient | null> | null = null;

type PostHogClient = typeof import('posthog-js')['default'];

export function createTelemetrySessionId(): string {
  return randomId();
}

export function configureTelemetry(
  context: TelemetryRuntimeContext | null,
  enabled: boolean,
): void {
  telemetryContext = context;
  telemetryEnabled = Boolean(context && enabled && projectToken && !isBrowserDntEnabled());

  if (!posthogClient) return;

  if (telemetryEnabled) {
    posthogClient.opt_in_capturing({ captureEventName: false });
  } else {
    posthogClient.opt_out_capturing();
  }
}

export function isTelemetryReady(): boolean {
  return Boolean(telemetryContext && telemetryEnabled && projectToken);
}

export function normalizeTelemetryProviderSetupIssueStatus(
  status: string | null | undefined,
): TelemetryProviderSetupIssueStatus | null {
  if (!status || status === 'connected' || status === 'ready') return null;
  if (status === 'needs_login') return 'needs_login';
  if (status === 'not_installed' || status === 'missing') return 'missing';
  return 'unavailable';
}

export async function captureTelemetryEvent(
  eventName: TelemetryEventName,
  properties: TelemetryEventProperties = {},
  options: TelemetryCaptureOptions = {},
): Promise<void> {
  if (!allowedEvents.has(eventName) || !isTelemetryReady()) return;

  const posthog = await loadPostHog();
  const context = telemetryContext;
  if (!posthog || !context || !telemetryEnabled) return;

  posthog.capture(
    eventName,
    {
      ...baseProperties(context),
      ...sanitizeTelemetryProperties(properties),
    },
    { transport: 'sendBeacon', ...options },
  );
}

export async function captureTelemetryOptOut(
  source: TelemetryOptOutSource,
): Promise<void> {
  await captureTelemetryEvent(
    'telemetry_opt_out',
    { source },
    { send_instantly: true, transport: 'sendBeacon' },
  );
}

export async function captureTelemetryFirstRun(
  context: TelemetryRuntimeContext,
): Promise<TelemetryFirstRunCaptureResult> {
  if (!projectToken || !isBrowser() || isBrowserDntEnabled()) return 'disabled';

  const posthog = await loadPostHog();
  if (!posthog) return 'failed';

  posthog.opt_in_capturing({ captureEventName: false });
  posthog.capture(
    'first_run_started',
    baseProperties(context),
    { send_instantly: true, transport: 'sendBeacon' },
  );

  if (!telemetryEnabled) {
    posthog.opt_out_capturing();
  }

  return 'captured';
}

function baseProperties(context: TelemetryRuntimeContext): TelemetryEventProperties {
  return {
    distinct_id: context.installId,
    install_id: context.installId,
    app_session_id: context.appSessionId,
    app_version: context.appVersion,
    platform: context.platform,
    arch: context.arch,
    channel: context.channel,
    $geoip_disable: true,
    $process_person_profile: false,
  };
}

function sanitizeTelemetryProperties(
  properties: TelemetryEventProperties,
): TelemetryEventProperties {
  const sanitized: TelemetryEventProperties = {};

  for (const [key, value] of Object.entries(properties)) {
    if (!allowedProperties.has(key)) continue;

    if (key === 'source' && (typeof value !== 'string' || !allowedSources.has(value))) continue;
    if (key === 'view' && (typeof value !== 'string' || !allowedViews.has(value))) continue;
    if (key === 'tab' && (typeof value !== 'string' || !allowedGitTabs.has(value))) continue;
    if (key === 'action' && (typeof value !== 'string' || !allowedGitActions.has(value))) continue;
    if (key === 'target' && (typeof value !== 'string' || !allowedGitTargets.has(value))) continue;
    if (key === 'file_state' && (typeof value !== 'string' || !allowedGitFileStates.has(value))) continue;
    if (
      key === 'status'
      && (typeof value !== 'string' || !allowedProviderIssueStatuses.has(value as TelemetryProviderSetupIssueStatus))
    ) continue;
    if (key === 'result' && (typeof value !== 'string' || !allowedProjectImportResults.has(value))) continue;
    if (key === 'error_code' && (typeof value !== 'string' || !allowedProjectImportErrorCodes.has(value))) continue;
    if (key === 'environment' && (typeof value !== 'string' || !allowedEnvironments.has(value))) continue;

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

async function loadPostHog(): Promise<PostHogClient | null> {
  if (!projectToken || !isBrowser()) return null;
  if (posthogClient) return posthogClient;
  if (posthogPromise) return posthogPromise;

  posthogPromise = import('posthog-js')
    .then(({ default: posthog }) => {
      const config: Partial<PostHogConfig> = {
        api_host: apiHost,
        ui_host: uiHost,
        autocapture: false,
        capture_pageview: false,
        capture_pageleave: false,
        capture_performance: false,
        capture_exceptions: false,
        capture_heatmaps: false,
        capture_dead_clicks: false,
        disable_session_recording: true,
        disable_surveys: true,
        disable_surveys_automatic_display: true,
        advanced_disable_flags: true,
        advanced_disable_feature_flags: true,
        advanced_disable_feature_flags_on_first_load: true,
        respect_dnt: true,
        person_profiles: 'never',
        opt_out_capturing_by_default: false,
        property_denylist: [
          '$current_url',
          '$host',
          '$pathname',
          '$raw_user_agent',
          '$referrer',
          '$referring_domain',
          '$screen_height',
          '$screen_width',
          '$session_entry_host',
          '$session_entry_pathname',
          '$session_entry_referrer',
          '$session_entry_referring_domain',
          '$session_entry_url',
          '$title',
          '$viewport_height',
          '$viewport_width',
        ],
        before_send: (captureResult: CaptureResult | null) => {
          if (!captureResult) return null;
          return allowedEvents.has(captureResult.event as TelemetryEventName)
            ? captureResult
            : null;
        },
        loaded: () => {
          if (telemetryEnabled) {
            posthog.opt_in_capturing({ captureEventName: false });
          } else {
            posthog.opt_out_capturing();
          }
        },
      };

      posthog.init(projectToken, config);
      posthogClient = posthog;
      return posthog;
    })
    .catch((error) => {
      console.warn('[telemetry] failed to load PostHog client', error);
      return null;
    });

  return posthogPromise;
}

function isBrowser(): boolean {
  return typeof window !== 'undefined';
}

function isBrowserDntEnabled(): boolean {
  if (!isBrowser()) return false;

  const navigatorDnt = navigator.doNotTrack;
  const windowDnt = (window as Window & { doNotTrack?: string }).doNotTrack;
  return navigatorDnt === '1' || windowDnt === '1' || navigatorDnt === 'yes';
}

function randomId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }

  return `anon-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}
