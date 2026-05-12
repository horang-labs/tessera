import type { NextRequest } from 'next/server';
import type {
  SetupProviderState,
  SetupStatusResponse,
} from '@/lib/setup/setup-status';
import type { CliDiagnosticProviderResult, CliDiagnosticReport } from '@/lib/cli/diagnostic-types';
import { captureServerTelemetryEvent } from './server';
import type { ServerTelemetryEventName } from './server';

export type SetupTelemetryTrigger =
  | 'initial'
  | 'manual_refresh'
  | 'environment_switch'
  | 'command_override_saved'
  | 'account_created';

interface SetupTelemetryOptions {
  trigger: SetupTelemetryTrigger;
  request?: NextRequest;
}

export type CliDiagnosticsTelemetrySource = 'setup' | 'settings';

interface CliDiagnosticsTelemetryOptions {
  source: CliDiagnosticsTelemetrySource;
  trigger?: SetupTelemetryTrigger;
  request?: NextRequest;
}

type DiagnosticFailureStage =
  | 'status_check'
  | 'spawn'
  | 'send_message'
  | 'receive_response'
  | 'cleanup'
  | 'none';

const RAW_LOG_CHUNK_BYTES = 512 * 1024;

export function parseSetupTelemetryTrigger(value: unknown): SetupTelemetryTrigger | null {
  if (
    value === 'initial'
    || value === 'manual_refresh'
    || value === 'environment_switch'
    || value === 'command_override_saved'
    || value === 'account_created'
  ) {
    return value;
  }
  return null;
}

export async function captureSetupStatusTelemetry(
  status: SetupStatusResponse,
  options: SetupTelemetryOptions,
): Promise<void> {
  const active = status.environments[status.activeEnvironment];
  const providers = Object.entries(status.environments)
    .flatMap(([environment, environmentState]) => (
      environmentState?.providers.map((provider) => ({
        environment,
        provider,
      })) ?? []
    ));

  await captureServerTelemetryEvent(
    'setup_cli_detection_summary',
    {
      source: 'setup',
      setup_trigger: options.trigger,
      active_environment: status.activeEnvironment,
      available_environments: status.availableEnvironments,
      is_windows_ecosystem: status.isWindowsEcosystem,
      is_fully_ready: status.isFullyReady,
      can_use_core_features: status.canUseCoreFeatures,
      ai_cli_status: active?.aiCli.status ?? 'unknown',
      git_status: active?.git.status ?? 'unknown',
      gh_status: active?.gh.status ?? 'unknown',
      connected_provider_ids: active?.providers
        .filter((provider) => provider.status === 'connected')
        .map((provider) => provider.providerId) ?? [],
      needs_login_provider_ids: active?.providers
        .filter((provider) => provider.status === 'needs_login')
        .map((provider) => provider.providerId) ?? [],
      missing_provider_ids: active?.providers
        .filter((provider) => provider.status === 'not_installed')
        .map((provider) => provider.providerId) ?? [],
      active_missing_but_other_environment_connected: hasOtherEnvironmentProviderStatus(
        status,
        'connected',
      ),
      active_missing_but_other_environment_needs_login: hasOtherEnvironmentProviderStatus(
        status,
        'needs_login',
      ),
      suggestion_tools: status.suggestions.map((suggestion) => suggestion.tool),
      suggestion_available_environments: status.suggestions.map((suggestion) => suggestion.availableEnvironment),
    },
    options.request,
  );

  await Promise.all(providers.map(({ environment, provider }) => captureProviderStatusTelemetry(
    status,
    environment,
    provider,
    options,
  )));
}

export async function captureCliDiagnosticsTelemetry(
  report: CliDiagnosticReport,
  options: CliDiagnosticsTelemetryOptions,
): Promise<void> {
  await Promise.all(report.providers.map((provider) => captureDiagnosticProviderTelemetry(
    report,
    provider,
    options,
  )));

  const firstSuccess = report.providers.find((provider) => provider.outcome === 'passed');
  const providersWithRawLog = report.providers.filter((provider) => provider.rawLogJsonl);
  const providersWithSmokeTrace = report.providers.filter((provider) => provider.smokeTraceJsonl);

  await captureServerTelemetryEvent(
    getDiagnosticsEventName(options.source, 'run_completed'),
    {
      source: options.source,
      ...(options.trigger ? { setup_trigger: options.trigger } : {}),
      run_id: report.id,
      active_environment: report.environment,
      tested_provider_count: report.providers.length,
      passed_provider_count: report.summary.passed,
      failed_provider_count: report.summary.failed,
      timeout_provider_count: report.summary.timeout,
      skipped_provider_count: report.summary.skipped,
      first_success_provider_id: firstSuccess?.providerId ?? '',
      first_success_environment: firstSuccess?.environment ?? '',
      can_continue: report.summary.passed > 0,
      raw_log_provider_count: providersWithRawLog.length,
      raw_log_total_bytes: providersWithRawLog.reduce(
        (total, provider) => total + (provider.rawLogBytes ?? 0),
        0,
      ),
      raw_log_truncated: report.providers.some((provider) => provider.rawLogTruncated === true),
      smoke_trace_provider_count: providersWithSmokeTrace.length,
      smoke_trace_event_count: providersWithSmokeTrace.reduce(
        (total, provider) => total + (provider.smokeTraceEventCount ?? 0),
        0,
      ),
    },
    options.request,
  );
}

async function captureProviderStatusTelemetry(
  status: SetupStatusResponse,
  environment: string,
  provider: SetupProviderState,
  options: SetupTelemetryOptions,
): Promise<void> {
  const isActiveEnvironment = environment === status.activeEnvironment;

  await captureServerTelemetryEvent(
    'setup_cli_provider_status',
    {
      source: 'setup',
      setup_trigger: options.trigger,
      provider_id: provider.providerId,
      environment,
      is_active_environment: isActiveEnvironment,
      provider_status: provider.status,
      provider_version: provider.version ?? '',
      command_source: provider.commandSource ?? 'default',
      command_shape: provider.commandShape ?? 'bare_command',
      version_failure_kind: provider.versionProbe?.failureKind ?? '',
      version_exit_code: provider.versionProbe?.exitCode,
      version_duration_ms: provider.versionProbe?.durationMs,
      auth_failure_kind: provider.authProbe?.failureKind ?? '',
      auth_exit_code: provider.authProbe?.exitCode,
      auth_duration_ms: provider.authProbe?.durationMs,
    },
    options.request,
  );
}

async function captureDiagnosticProviderTelemetry(
  report: CliDiagnosticReport,
  provider: CliDiagnosticProviderResult,
  options: CliDiagnosticsTelemetryOptions,
): Promise<void> {
  const failureStage = classifyDiagnosticFailureStage(provider);

  await captureServerTelemetryEvent(
    getDiagnosticsEventName(options.source, 'provider_result'),
    {
      source: options.source,
      ...(options.trigger ? { setup_trigger: options.trigger } : {}),
      run_id: report.id,
      provider_id: provider.providerId,
      environment: provider.environment,
      is_active_environment: provider.environment === report.environment,
      provider_status: provider.connectionStatus,
      provider_version: provider.version ?? '',
      command_source: provider.commandSource ?? 'default',
      command_shape: provider.commandShape ?? 'bare_command',
      status_check_status: provider.steps.statusCheck.status,
      spawn_status: provider.steps.spawn.status,
      send_status: provider.steps.sendMessage.status,
      response_status: provider.steps.receiveResponse.status,
      cleanup_status: provider.steps.cleanup.status,
      final_status: provider.outcome,
      failure_stage: failureStage,
      duration_ms: provider.durationMs,
      version_failure_kind: provider.versionProbe?.failureKind ?? '',
      version_exit_code: provider.versionProbe?.exitCode,
      version_duration_ms: provider.versionProbe?.durationMs,
      auth_failure_kind: provider.authProbe?.failureKind ?? '',
      auth_exit_code: provider.authProbe?.exitCode,
      auth_duration_ms: provider.authProbe?.durationMs,
      spawn_duration_ms: provider.steps.spawn.durationMs,
      spawn_error_message: provider.steps.spawn.status === 'failed'
        ? provider.spawnErrorMessage ?? provider.steps.spawn.message ?? ''
        : '',
      response_duration_ms: provider.steps.receiveResponse.durationMs,
      smoke_trace_jsonl: provider.smokeTraceJsonl ?? '',
      smoke_trace_event_count: provider.smokeTraceEventCount ?? 0,
    },
    options.request,
  );

  await captureDiagnosticRawLogTelemetry(report, provider, options);
}

function hasOtherEnvironmentProviderStatus(
  status: SetupStatusResponse,
  providerStatus: SetupProviderState['status'],
): boolean {
  const active = status.environments[status.activeEnvironment];
  if (!active) return false;

  return active.providers.some((provider) => {
    if (provider.status === 'connected') return false;
    return Object.entries(status.environments).some(([environment, environmentState]) => {
      if (environment === status.activeEnvironment) return false;
      return environmentState?.providers.some((candidate) => (
        candidate.providerId === provider.providerId
        && candidate.status === providerStatus
      ));
    });
  });
}

async function captureDiagnosticRawLogTelemetry(
  report: CliDiagnosticReport,
  provider: CliDiagnosticProviderResult,
  options: CliDiagnosticsTelemetryOptions,
): Promise<void> {
  const rawLogJsonl = provider.rawLogJsonl;
  if (!rawLogJsonl) return;

  const chunks = chunkRawLogJsonl(rawLogJsonl, RAW_LOG_CHUNK_BYTES);
  await Promise.all(chunks.map((chunk, index) => captureServerTelemetryEvent(
    getDiagnosticsEventName(options.source, 'raw_log'),
    {
      source: options.source,
      ...(options.trigger ? { setup_trigger: options.trigger } : {}),
      run_id: report.id,
      report_id: report.id,
      provider_id: provider.providerId,
      environment: provider.environment,
      final_status: provider.outcome,
      chunk_index: index,
      chunk_count: chunks.length,
      raw_log_jsonl: chunk,
      raw_log_total_bytes: provider.rawLogBytes ?? Buffer.byteLength(rawLogJsonl),
      raw_log_chunk_bytes: Buffer.byteLength(chunk),
      raw_log_event_count: provider.rawLogEventCount,
      raw_log_truncated: provider.rawLogTruncated ?? false,
    },
    options.request,
  )));
}

function classifyDiagnosticFailureStage(provider: CliDiagnosticProviderResult): DiagnosticFailureStage {
  if (provider.outcome === 'passed') {
    return 'none';
  }

  if (provider.connectionStatus !== 'connected') {
    return 'status_check';
  }

  if (provider.steps.spawn.status !== 'passed') {
    return 'spawn';
  }

  if (provider.steps.sendMessage.status !== 'passed') {
    return 'send_message';
  }

  if (provider.steps.receiveResponse.status !== 'passed') {
    return 'receive_response';
  }

  if (provider.steps.cleanup.status !== 'passed') {
    return 'cleanup';
  }

  return 'none';
}

function getDiagnosticsEventName(
  source: CliDiagnosticsTelemetrySource,
  event: 'provider_result' | 'raw_log' | 'run_completed',
): ServerTelemetryEventName {
  if (source === 'settings') {
    if (event === 'provider_result') return 'settings_cli_diagnostics_provider_result';
    if (event === 'raw_log') return 'settings_cli_diagnostics_raw_log';
    return 'settings_cli_diagnostics_run_completed';
  }

  if (event === 'provider_result') return 'setup_cli_smoke_provider_result';
  if (event === 'raw_log') return 'setup_cli_smoke_raw_log';
  return 'setup_cli_smoke_run_completed';
}

function chunkRawLogJsonl(value: string, maxBytes: number): string[] {
  const chunks: string[] = [];
  let current = '';
  let currentBytes = 0;

  for (const char of value) {
    const charBytes = Buffer.byteLength(char);
    if (currentBytes + charBytes > maxBytes) {
      if (current) chunks.push(current);
      current = char;
      currentBytes = charBytes;
      continue;
    }
    current += char;
    currentBytes += charBytes;
  }

  if (current) chunks.push(current);
  return chunks;
}
