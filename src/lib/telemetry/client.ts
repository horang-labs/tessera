import type { CaptureOptions, CaptureResult, PostHogConfig } from 'posthog-js';
import type { ServerHostInfo } from '@/lib/system/types';
import {
  isTelemetryUiControl,
  isTelemetryUiSurface,
  sanitizeAutocaptureClickProperties,
  type TelemetryUiControl,
  type TelemetryUiSurface,
} from './ui-click';
import {
  normalizeTelemetryFormFactor,
  normalizeTelemetryPromptSource,
  normalizeTelemetryProvider,
} from './usage-dimensions';

export type TelemetryEventName =
  | 'first_run_started'
  | 'setup_completed'
  | 'app_started'
  | 'app_usage_heartbeat'
  | 'agent_session_started'
  | 'agent_usage_heartbeat'
  | 'session_created'
  | 'task_created'
  | 'workspace_view_changed'
  | 'settings_changed'
  | 'provider_setup_issue_seen'
  | 'project_import_result'
  | 'git_panel_opened'
  | 'git_panel_tab_changed'
  | 'git_file_opened'
  | 'git_action_triggered'
  | 'ai_title_generation_result'
  | 'prompt_submitted'
  | 'prompt_turn_finished'
  | 'keyboard_shortcut_used'
  | 'workspace_item_moved'
  | 'workspace_file_edit_started'
  | 'workspace_file_action_result'
  | 'ui_control_clicked'
  | 'provider_selected'
  | 'telemetry_opt_out';

export type TelemetryOptOutSource = 'setup' | 'settings';
export type TelemetryProviderSetupIssueStatus = 'missing' | 'needs_login' | 'unavailable';
export type TelemetryClientFormFactor = 'mobile' | 'desktop';

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
const postHogEnvironmentPropertyNames = [
  '$browser',
  '$browser_language',
  '$browser_language_prefix',
  '$browser_version',
  '$timezone',
] as const;

const projectToken = process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN;
const apiHost = process.env.NEXT_PUBLIC_POSTHOG_API_HOST || '/ingest';
const uiHost = process.env.NEXT_PUBLIC_POSTHOG_UI_HOST || 'https://us.posthog.com';

const allowedEvents = new Set<TelemetryEventName>([
  'first_run_started',
  'setup_completed',
  'app_started',
  'app_usage_heartbeat',
  'agent_session_started',
  'agent_usage_heartbeat',
  'session_created',
  'task_created',
  'workspace_view_changed',
  'settings_changed',
  'provider_setup_issue_seen',
  'project_import_result',
  'git_panel_opened',
  'git_panel_tab_changed',
  'git_file_opened',
  'git_action_triggered',
  'ai_title_generation_result',
  'prompt_submitted',
  'prompt_turn_finished',
  'keyboard_shortcut_used',
  'workspace_item_moved',
  'workspace_file_edit_started',
  'workspace_file_action_result',
  'ui_control_clicked',
  'provider_selected',
  'telemetry_opt_out',
]);

const allowedProperties = new Set([
  ...postHogEnvironmentPropertyNames,
  '$geoip_disable',
  '$process_person_profile',
  'active_seconds',
  'app_session_id',
  'app_version',
  'arch',
  'channel',
  'client_form_factor',
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
  'setting',
  'tab',
  'target',
  'view',
  'action',
  'control',
  'surface',
  'failure_kind',
  'file_count',
  'shortcut',
  'item_type',
  'move_kind',
  'item_count',
  'has_skill',
  'has_attachment',
  'attachment_count',
  'has_session_reference',
  'translation_requested',
  'used_voice_input',
  'duration_bucket',
  'session_kind',
  'readiness',
  'execution_mode',
  'file_action',
  'entry_kind',
]);

const allowedSources = new Set([
  'setup',
  'settings',
  'new_session',
  'kanban',
  'list',
  'project_import',
  'git_panel',
  'manual',
  'gui',
  'pty_chat_view',
  'pty_direct',
]);
const allowedViews = new Set(['list', 'kanban']);
const allowedGitTabs = new Set(['git', 'files', 'scripts', 'memory']);
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
  'generate_commit_message',
  'copy_file_path',
  'abort',
]);
const allowedGitTargets = new Set([
  'repository',
  'pull_request',
  'checks',
  'branch',
  'worktree_path',
  'diff',
  'file',
  'commit_message',
  'commit',
  'conflict',
  'file_path',
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
const allowedResults = new Set([
  'success',
  'failed',
  'fallback',
  'no_conversation',
  'cancelled',
  'stopped',
  'input_required',
  'conflict',
]);
const allowedDurationBuckets = new Set([
  'under_10s',
  '10_to_30s',
  '30_to_120s',
  'over_120s',
]);
const allowedProjectImportErrorCodes = new Set([
  'environment_mismatch',
  'permission_denied',
  'missing_folder',
  'invalid_folder',
  'unknown',
]);
const allowedEnvironments = new Set(['native', 'wsl']);
const allowedClientFormFactors = new Set<TelemetryClientFormFactor>(['mobile', 'desktop']);
const allowedSettings = new Set([
  'language',
  'agentExecutionMode',
  'terminalSessionDefaultView',
  'defaultNewSessionKind',
  'profile',
  'notifications',
  'translate',
  'theme',
  'terminalThemeLightPreset',
  'terminalThemeDarkPreset',
  'fontSize',
  'enterKeyBehavior',
  'defaultPermissionMode',
  'defaultModel',
  'providerDefaults',
  'providerCustomModels',
  'inactivePanelDimming',
  'showProviderIcons',
  'showRecentWork',
  'kanbanSessionOpenMode',
  'sttEngine',
  'geminiApiKey',
  'favoriteSkills',
  'agentEnvironment',
  'cliCommandOverrides',
  'windowsCloseBehavior',
  'setup',
  'telemetry',
  'autoDeleteArchivedWorktrees',
  'archivedWorktreeRetentionDays',
  'managedWorktreePathTemplate',
  'shortcutOverrides',
  'gitConfig',
]);
const allowedShortcuts = new Set([
  'new-tab',
  'close-tab',
  'toggle-sidebar',
  'toggle-view',
  'toggle-terminal-view',
  'split-right',
  'split-down',
  'toggle-terminal',
  'focus-panel-left',
  'focus-panel-right',
  'focus-panel-up',
  'focus-panel-down',
  'voice-input',
  'toggle-plan-mode',
  'toggle-fast-mode',
  'open-model-selector',
  'open-reasoning-selector',
  'save-memory-file',
  'save-workspace-file',
]);
const allowedWorkspaceItemTypes = new Set([
  'project',
  'tab',
  'task',
  'chat',
  'session',
  'collection',
]);
const allowedWorkspaceMoveKinds = new Set([
  'reorder',
  'workflow_status',
  'collection',
  'panel',
  'reference',
]);
const allowedSessionKinds = new Set(['chat', 'terminal']);
const allowedReadiness = new Set(['ready', 'limited']);
const allowedExecutionModes = new Set(['gui', 'pty']);
const allowedFileActions = new Set(['create', 'save', 'rename', 'delete']);
const allowedEntryKinds = new Set(['file', 'directory']);

let telemetryContext: TelemetryRuntimeContext | null = null;
let telemetryEnabled = false;
let posthogClient: PostHogClient | null = null;
let posthogPromise: Promise<PostHogClient | null> | null = null;
const pendingPromptTurns = new Map<string, {
  source: 'gui' | 'pty_chat_view' | 'pty_direct';
  startedAt: number;
}>();

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
  if (!telemetryEnabled) pendingPromptTurns.clear();

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

export function captureTelemetryPromptSubmitted(
  correlationKey: string,
  properties: TelemetryEventProperties,
): Promise<void> {
  captureCloudflarePromptBeacon(properties.provider_id, properties.source);
  const source = properties.source;
  if (
    isTelemetryReady()
    && correlationKey.length > 0
    && typeof source === 'string'
    && (source === 'gui' || source === 'pty_chat_view' || source === 'pty_direct')
  ) {
    pendingPromptTurns.set(correlationKey, { source, startedAt: Date.now() });
  }
  return captureTelemetryEvent('prompt_submitted', properties);
}

/**
 * Content-free operational beacon. Unlike PostHog product telemetry this is
 * deliberately independent of opt-out/DNT: it only proves an installed app
 * reached a prompt submission boundary. The same-origin server route receives
 * no prompt, session identifier, or user-authored value. Provider and submission
 * source are reduced to closed enums before they leave the browser.
 */
function captureCloudflarePromptBeacon(provider: unknown, source: unknown): void {
  if (!isBrowser()) return;
  void fetch('/api/telemetry/prompt-beacon', {
    method: 'POST',
    headers: {
      'X-Tessera-Provider': normalizeTelemetryProvider(provider),
      'X-Tessera-Source': normalizeTelemetryPromptSource(source),
      'X-Tessera-Form-Factor': normalizeTelemetryFormFactor(
        detectTelemetryClientFormFactor(),
      ),
    },
    keepalive: true,
  }).catch(() => {
    // Usage beacons must never affect prompt delivery.
  });
}

export function captureTelemetryPromptTurnFinished(
  correlationKey: string,
  result: 'success' | 'failed' | 'cancelled' | 'stopped' | 'input_required',
): Promise<void> {
  const pending = pendingPromptTurns.get(correlationKey);
  if (!pending) return Promise.resolve();
  pendingPromptTurns.delete(correlationKey);

  return captureTelemetryEvent('prompt_turn_finished', {
    source: pending.source,
    result,
    duration_bucket: getTelemetryDurationBucket(Date.now() - pending.startedAt),
  });
}

export function captureTelemetryUiControl(
  control: TelemetryUiControl,
  surface: TelemetryUiSurface,
): Promise<void> {
  return captureTelemetryEvent('ui_control_clicked', { control, surface });
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
    client_form_factor: detectTelemetryClientFormFactor(),
    $geoip_disable: true,
    $process_person_profile: false,
  };
}

export function sanitizeTelemetryProperties(
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
    if (key === 'result' && (typeof value !== 'string' || !allowedResults.has(value))) continue;
    if (key === 'error_code' && (typeof value !== 'string' || !allowedProjectImportErrorCodes.has(value))) continue;
    if (key === 'environment' && (typeof value !== 'string' || !allowedEnvironments.has(value))) continue;
    if (
      key === 'client_form_factor'
      && (typeof value !== 'string' || !allowedClientFormFactors.has(value as TelemetryClientFormFactor))
    ) continue;
    if (key === 'setting' && (typeof value !== 'string' || !allowedSettings.has(value))) continue;
    if (key === 'shortcut' && (typeof value !== 'string' || !allowedShortcuts.has(value))) continue;
    if (key === 'item_type' && (typeof value !== 'string' || !allowedWorkspaceItemTypes.has(value))) continue;
    if (key === 'move_kind' && (typeof value !== 'string' || !allowedWorkspaceMoveKinds.has(value))) continue;
    if (key === 'duration_bucket' && (typeof value !== 'string' || !allowedDurationBuckets.has(value))) continue;
    if (key === 'session_kind' && (typeof value !== 'string' || !allowedSessionKinds.has(value))) continue;
    if (key === 'readiness' && (typeof value !== 'string' || !allowedReadiness.has(value))) continue;
    if (key === 'execution_mode' && (typeof value !== 'string' || !allowedExecutionModes.has(value))) continue;
    if (key === 'file_action' && (typeof value !== 'string' || !allowedFileActions.has(value))) continue;
    if (key === 'entry_kind' && (typeof value !== 'string' || !allowedEntryKinds.has(value))) continue;
    if (key === 'control' && !isTelemetryUiControl(value)) continue;
    if (key === 'surface' && !isTelemetryUiSurface(value)) continue;

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

function sanitizePostHogEnvironmentProperties(
  properties: TelemetryEventProperties,
): TelemetryEventProperties {
  const sanitized = sanitizeTelemetryProperties(properties);
  const environmentProperties: TelemetryEventProperties = {};

  for (const key of postHogEnvironmentPropertyNames) {
    if (sanitized[key] !== undefined) environmentProperties[key] = sanitized[key];
  }

  return environmentProperties;
}

export function prepareTelemetryCaptureForTransport(
  captureResult: CaptureResult | null,
  context: TelemetryRuntimeContext | null = telemetryContext,
  enabled: boolean = telemetryEnabled,
  transportToken: string | undefined = projectToken,
): CaptureResult | null {
  if (!captureResult || !transportToken) return null;

  if (captureResult.event === '$autocapture') {
    const clickProperties = sanitizeAutocaptureClickProperties(captureResult.properties ?? {});
    if (!clickProperties || !context || !enabled) return null;

    return {
      ...captureResult,
      event: 'ui_control_clicked',
      properties: {
        token: transportToken,
        ...baseProperties(context),
        ...sanitizePostHogEnvironmentProperties(captureResult.properties ?? {}),
        ...clickProperties,
      },
    };
  }

  if (!allowedEvents.has(captureResult.event as TelemetryEventName)) return null;

  return {
    ...captureResult,
    // `token` is the public PostHog project token required by the ingestion API.
    // Everything else is rebuilt from Tessera's explicit property allowlist.
    properties: {
      token: transportToken,
      ...sanitizeTelemetryProperties(captureResult.properties ?? {}),
    },
  };
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
        autocapture: {
          dom_event_allowlist: ['click'],
          css_selector_allowlist: ['[data-ph-capture]'],
          element_attribute_ignorelist: [
            'id',
            'title',
            'aria-label',
            'href',
            'name',
            'value',
            'data-testid',
          ],
          capture_copied_text: false,
        },
        mask_all_text: true,
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
        before_send: prepareTelemetryCaptureForTransport,
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

interface TelemetryNavigatorLike {
  userAgent?: string;
  platform?: string;
  maxTouchPoints?: number;
  userAgentData?: { mobile?: boolean };
}

/**
 * Reduce browser device signals to one non-identifying usage dimension. Raw
 * user-agent, viewport, screen, and touch data never leave the client.
 */
export function detectTelemetryClientFormFactor(
  navigatorLike: TelemetryNavigatorLike | undefined = typeof navigator === 'undefined'
    ? undefined
    : navigator as TelemetryNavigatorLike,
): TelemetryClientFormFactor {
  if (navigatorLike?.userAgentData?.mobile === true) return 'mobile';

  const userAgent = navigatorLike?.userAgent ?? '';
  if (/Android|iPhone|iPad|iPod|IEMobile|Opera Mini|Mobile/i.test(userAgent)) {
    return 'mobile';
  }

  // iPadOS can request desktop sites and identify as Macintosh.
  if (
    /Macintosh/i.test(userAgent)
    && (navigatorLike?.maxTouchPoints ?? 0) > 1
  ) {
    return 'mobile';
  }

  return 'desktop';
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

function getTelemetryDurationBucket(durationMs: number): string {
  if (durationMs < 10_000) return 'under_10s';
  if (durationMs < 30_000) return '10_to_30s';
  if (durationMs < 120_000) return '30_to_120s';
  return 'over_120s';
}
