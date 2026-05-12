import '@/lib/cli/providers/bootstrap';

import { randomUUID } from 'crypto';
import type { ChildProcess } from 'child_process';
import { createWriteStream, type WriteStream } from 'fs';
import fs from 'fs/promises';
import path from 'path';
import { getCliStatusSnapshot, type CliStatusEntry } from './connection-checker';
import { gracefulKillProcess } from './process-termination';
import { getAgentEnvironment } from './spawn-cli';
import { cliProviderRegistry, type CliProviderRegistry } from './providers/registry';
import type { CliProvider, ParsedMessage } from './providers/types';
import type { CliRawLogEvent, CliRawLogSink } from './providers/session-types';
import type { AgentEnvironment } from '@/lib/settings/types';
import { getTesseraDataPath } from '@/lib/tessera-data-dir';
import logger from '@/lib/logger';
import type {
  CliDiagnosticExportResult,
  CliDiagnosticProviderResult,
  CliDiagnosticReport,
  CliDiagnosticStep,
  CliDiagnosticStepStatus,
} from './diagnostic-types';

const DEFAULT_DIAGNOSTIC_PROMPT = 'hi';
const DEFAULT_STARTUP_TIMEOUT_MS = 15_000;
const DEFAULT_RESPONSE_TIMEOUT_MS = 45_000;
const ASSISTANT_PREVIEW_LIMIT = 240;
const ERROR_PREVIEW_LIMIT = 500;
const TELEMETRY_RAW_LOG_MAX_REPORT_BYTES = 12 * 1024 * 1024;
const REPORTS_KEY = Symbol.for('tessera.cliDiagnostics.latestReports');

type KillProcess = typeof gracefulKillProcess;

interface RunCliDiagnosticsOptions {
  registry?: CliProviderRegistry;
  environment?: AgentEnvironment;
  statusEntries?: CliStatusEntry[];
  prompt?: string;
  workDir?: string;
  startupTimeoutMs?: number;
  responseTimeoutMs?: number;
  killProcess?: KillProcess;
  now?: () => Date;
  storeLatest?: boolean;
  writeRawLogs?: boolean;
  captureTelemetryRawLog?: boolean;
}

interface DiagnosticTurnResult {
  sendStep: CliDiagnosticStep;
  receiveStep: CliDiagnosticStep;
  outcome: CliDiagnosticStepStatus;
  assistantPreview?: string;
  assistantMessageChars?: number;
  processExited: boolean;
}

interface RawLogWriter {
  path?: string;
  sink: CliRawLogSink;
  close: () => Promise<void>;
  getTelemetryLog?: () => RawLogTelemetryLog;
}

interface RawLogTelemetryLog {
  jsonl: string;
  bytes: number;
  eventCount: number;
  truncated: boolean;
}

interface RawLogTelemetryBudget {
  remainingBytes: number;
  isTruncated: boolean;
}

interface LatestReportStore {
  byUserId: Map<string, CliDiagnosticReport>;
}

interface SmokeTraceRecorder {
  record: (event: Record<string, unknown>) => void;
  toJsonl: () => string;
  count: () => number;
}

function getLatestReportStore(): LatestReportStore {
  const globalWithStore = globalThis as unknown as Record<symbol, LatestReportStore | undefined>;
  if (!globalWithStore[REPORTS_KEY]) {
    globalWithStore[REPORTS_KEY] = { byUserId: new Map() };
  }
  return globalWithStore[REPORTS_KEY]!;
}

function makeStep(
  status: CliDiagnosticStepStatus,
  startedAt: number,
  message?: string,
): CliDiagnosticStep {
  return {
    status,
    durationMs: Date.now() - startedAt,
    ...(message ? { message: sanitizeDiagnosticMessage(message) } : {}),
  };
}

function makeStaticStep(status: CliDiagnosticStepStatus, message?: string): CliDiagnosticStep {
  return {
    status,
    ...(message ? { message: sanitizeDiagnosticMessage(message) } : {}),
  };
}

function sanitizeDiagnosticMessage(message: string): string {
  return message
    .replace(/\x1b\[[0-9;]*m/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, ERROR_PREVIEW_LIMIT);
}

function buildAssistantPreview(content: string): string | undefined {
  const preview = content.replace(/\s+/g, ' ').trim().slice(0, ASSISTANT_PREVIEW_LIMIT);
  return preview || undefined;
}

function createSmokeTraceRecorder(
  providerId: string,
  environment: AgentEnvironment,
): SmokeTraceRecorder {
  const lines: string[] = [];
  let seq = 0;

  return {
    record: (event) => {
      seq += 1;
      lines.push(`${JSON.stringify(removeUndefinedProperties({
        schema_version: 1,
        seq,
        provider_id: providerId,
        environment,
        ...event,
      }))}\n`);
    },
    toJsonl: () => lines.join(''),
    count: () => seq,
  };
}

function removeUndefinedProperties(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  );
}

function recordSmokeTraceStep(
  trace: SmokeTraceRecorder,
  step: string,
  result: CliDiagnosticStep,
  extra: Record<string, unknown> = {},
): void {
  trace.record({
    event: 'step_completed',
    step,
    status: result.status,
    duration_ms: result.durationMs,
    ...extra,
  });
}

function getDiagnosticPromptKind(prompt: string): 'fixed_hi' | 'custom' {
  return prompt === DEFAULT_DIAGNOSTIC_PROMPT ? 'fixed_hi' : 'custom';
}

function getAssistantContent(message: ParsedMessage): string {
  const serverMessage = message.serverMessage;
  if (
    serverMessage
    && serverMessage.type === 'message'
    && serverMessage.role === 'assistant'
    && typeof serverMessage.content === 'string'
  ) {
    return serverMessage.content;
  }
  return '';
}

function getStatusForEnvironment(
  statuses: CliStatusEntry[],
  providerId: string,
  environment: AgentEnvironment,
): CliStatusEntry {
  return statuses.find((entry) => (
    entry.providerId === providerId && entry.environment === environment
  )) ?? {
    providerId,
    environment,
    status: 'not_installed',
  };
}

function summarizeProviders(providers: CliDiagnosticProviderResult[]): CliDiagnosticReport['summary'] {
  return providers.reduce(
    (summary, provider) => {
      summary[provider.outcome] += 1;
      summary.total += 1;
      return summary;
    },
    { passed: 0, failed: 0, skipped: 0, timeout: 0, total: 0 },
  );
}

function formatTimestampForFilename(value: string): string {
  return value.replace(/[:.]/g, '-').replace(/[^\dA-Za-z-]/g, '');
}

function sanitizeFilePart(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '-');
}

async function resolveRawLogDir(reportId: string, generatedAt: string): Promise<string> {
  const dir = getTesseraDataPath(
    'diagnostic-raw-logs',
    `${formatTimestampForFilename(generatedAt)}-${reportId.slice(0, 8)}`,
  );
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function writeRawLogEvent(stream: WriteStream, event: CliRawLogEvent): void {
  stream.write(`${JSON.stringify({
    timestamp: new Date().toISOString(),
    direction: event.direction,
    phase: event.phase,
    byteLength: Buffer.byteLength(event.data),
    data: event.data,
  })}\n`);
}

function createRawLogWriter(filePath: string): RawLogWriter {
  const stream = createWriteStream(filePath, {
    flags: 'a',
    mode: 0o600,
    encoding: 'utf8',
  });
  let isClosed = false;

  return {
    path: filePath,
    sink: (event) => {
      if (!isClosed) {
        writeRawLogEvent(stream, event);
      }
    },
    close: () => new Promise<void>((resolve, reject) => {
      isClosed = true;
      const onError = (error: Error) => {
        stream.removeListener('finish', onFinish);
        reject(error);
      };
      const onFinish = () => {
        stream.removeListener('error', onError);
        resolve();
      };

      stream.once('error', onError);
      stream.once('finish', onFinish);
      stream.end();
    }),
  };
}

function createNoopRawLogWriter(): RawLogWriter {
  return {
    sink: () => {},
    close: async () => {},
  };
}

function createCompositeRawLogWriter(writers: RawLogWriter[]): RawLogWriter {
  return {
    path: writers.find((writer) => writer.path)?.path,
    sink: (event) => {
      for (const writer of writers) {
        writer.sink(event);
      }
    },
    close: async () => {
      await Promise.all(writers.map((writer) => writer.close()));
    },
    getTelemetryLog: () => writers.find((writer) => writer.getTelemetryLog)?.getTelemetryLog?.() ?? {
      jsonl: '',
      bytes: 0,
      eventCount: 0,
      truncated: false,
    },
  };
}

function createTelemetryRawLogWriter(budget: RawLogTelemetryBudget): RawLogWriter {
  const lines: string[] = [];
  let totalLength = 0;
  let eventCount = 0;
  let truncated = false;

  return {
    sink: (event) => {
      eventCount += 1;

      const line = `${JSON.stringify({
        direction: event.direction,
        phase: event.phase,
        byteLength: Buffer.byteLength(event.data),
        data: sanitizeRawLogTelemetryData(event),
      })}\n`;
      const lineLength = Buffer.byteLength(line);

      if (lineLength > budget.remainingBytes) {
        truncated = true;
        budget.isTruncated = true;
        return;
      }

      lines.push(line);
      totalLength += lineLength;
      budget.remainingBytes -= lineLength;
    },
    close: async () => {},
    getTelemetryLog: () => ({
      jsonl: lines.join(''),
      bytes: totalLength,
      eventCount,
      truncated: truncated || budget.isTruncated,
    }),
  };
}

function sanitizeRawLogTelemetryData(event: CliRawLogEvent): string {
  if (event.direction === 'event' && event.phase === 'spawn') {
    return sanitizeSpawnMetadata(event.data);
  }

  return redactSensitiveRawLogText(event.data);
}

function sanitizeSpawnMetadata(data: string): string {
  try {
    const raw = JSON.parse(data) as Record<string, unknown>;
    const sanitized = {
      providerId: typeof raw.providerId === 'string' ? raw.providerId : undefined,
      args: Array.isArray(raw.args)
        ? raw.args.filter((item): item is string => typeof item === 'string')
        : undefined,
      cwd: raw.cwd ? '[path]' : undefined,
      requestedCwd: raw.requestedCwd ? '[path]' : undefined,
      agentEnv: typeof raw.agentEnv === 'string' ? raw.agentEnv : undefined,
      commandShape: typeof raw.command === 'string' ? getRawLogCommandShape(raw.command) : undefined,
    };
    return redactSensitiveRawLogText(JSON.stringify(sanitized));
  } catch {
    return redactSensitiveRawLogText(data);
  }
}

function getRawLogCommandShape(command: string): string {
  const trimmed = command.trim();
  if (!trimmed) return 'other';
  if (
    trimmed.startsWith('/')
    || /^[A-Za-z]:[\\/]/.test(trimmed)
    || /^\\\\[^\\]+\\[^\\]+/.test(trimmed)
    || /^\/\/[^/]+\/[^/]+/.test(trimmed)
  ) {
    return 'absolute_path';
  }
  if (trimmed.includes('/') || trimmed.includes('\\')) return 'relative_path';
  if (/^[A-Za-z0-9._-]+$/.test(trimmed)) return 'bare_command';
  return 'other';
}

function redactSensitiveRawLogText(value: string): string {
  return value
    .replace(/\x1b\[[0-9;]*m/g, '')
    .replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '[email]')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi, '[uuid]')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{20,})\b/g, '[token]')
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, '[token]')
    .replace(/("?(?:api[_-]?key|token|secret|password|authorization)"?\s*[:=]\s*)["']?[^"',\s}]+/gi, '$1[token]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{20,}\b/gi, 'Bearer [token]')
    .replace(/\\\\[^\s"']+(?:\\[^\s"']+)*/g, '[path]')
    .replace(/\b[A-Za-z]:\\[^\s"']+/g, '[path]')
    .replace(/(?:^|[\s"'(:])\/(?:Users|home|var|tmp|private|mnt|opt|usr|Volumes)\/[^\s"')]+/g, (match) => (
      `${match[0] === '/' ? '' : match[0]}[path]`
    ))
    .replace(/\b[A-Za-z0-9+/=_-]{48,}\b/g, '[token]');
}

async function resolveDiagnosticWorkDir(workDir?: string): Promise<string> {
  const resolved = workDir ?? getTesseraDataPath('diagnostics', 'workspace');
  await fs.mkdir(resolved, { recursive: true, mode: 0o700 });
  return resolved;
}

function parseProviderLine(provider: CliProvider, sessionId: string, line: string): ParsedMessage[] {
  if (provider.parseSessionStdout) {
    return provider.parseSessionStdout(sessionId, line);
  }

  const parsed = provider.parseStdout(line);
  return parsed ? [parsed] : [];
}

function executeDiagnosticTurn(
  provider: CliProvider,
  proc: ChildProcess,
  sessionId: string,
  prompt: string,
  responseTimeoutMs: number,
): Promise<DiagnosticTurnResult> {
  return new Promise((resolve) => {
    let buffer = '';
    let assistantContent = '';
    let processExited = false;
    let settled = false;
    const receiveStartedAt = Date.now();

    const timeout = setTimeout(() => {
      finish({
        sendStep: makeStaticStep('passed'),
        receiveStep: makeStep('timeout', receiveStartedAt, `No assistant response within ${responseTimeoutMs}ms`),
        outcome: 'timeout',
        assistantPreview: buildAssistantPreview(assistantContent),
        assistantMessageChars: assistantContent.trim().length,
        processExited,
      });
    }, responseTimeoutMs);

    const cleanup = () => {
      clearTimeout(timeout);
      proc.stdout?.removeListener('data', onData);
      proc.removeListener('error', onError);
      proc.removeListener('close', onClose);
    };

    const finish = (result: DiagnosticTurnResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };

    const onData = (chunk: Buffer | string) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        let parsedMessages: ParsedMessage[];
        try {
          parsedMessages = parseProviderLine(provider, sessionId, trimmed);
        } catch (error) {
          finish({
            sendStep: makeStaticStep('passed'),
            receiveStep: makeStep('failed', receiveStartedAt, `Parser error: ${(error as Error).message}`),
            outcome: 'failed',
            assistantPreview: buildAssistantPreview(assistantContent),
            assistantMessageChars: assistantContent.trim().length,
            processExited,
          });
          return;
        }

        for (const message of parsedMessages) {
          assistantContent += getAssistantContent(message);
          if (assistantContent.trim()) {
            finish({
              sendStep: makeStaticStep('passed'),
              receiveStep: makeStep('passed', receiveStartedAt),
              outcome: 'passed',
              assistantPreview: buildAssistantPreview(assistantContent),
              assistantMessageChars: assistantContent.trim().length,
              processExited,
            });
            return;
          }
        }
      }
    };

    const onError = (error: Error) => {
      finish({
        sendStep: makeStaticStep('passed'),
        receiveStep: makeStep('failed', receiveStartedAt, `Process error: ${error.message}`),
        outcome: 'failed',
        assistantPreview: buildAssistantPreview(assistantContent),
        assistantMessageChars: assistantContent.trim().length,
        processExited,
      });
    };

    const onClose = (code: number | null) => {
      processExited = true;
      finish({
        sendStep: makeStaticStep('passed'),
        receiveStep: makeStep('failed', receiveStartedAt, `Process closed before response (code=${code ?? 'unknown'})`),
        outcome: 'failed',
        assistantPreview: buildAssistantPreview(assistantContent),
        assistantMessageChars: assistantContent.trim().length,
        processExited,
      });
    };

    proc.stdout?.on('data', onData);
    proc.once('error', onError);
    proc.once('close', onClose);

    try {
      provider.onSessionReady?.(proc, sessionId);
    } catch (error) {
      logger.warn('CLI diagnostics: provider onSessionReady failed', {
        providerId: provider.getProviderId(),
        sessionId,
        error: (error as Error).message,
      });
    }

    const sendStartedAt = Date.now();
    try {
      const sent = provider.sendMessage(proc, prompt);
      if (!sent) {
        finish({
          sendStep: makeStep('failed', sendStartedAt, 'Provider did not accept diagnostic prompt'),
          receiveStep: makeStaticStep('skipped', 'Message was not sent'),
          outcome: 'failed',
          assistantPreview: undefined,
          assistantMessageChars: 0,
          processExited,
        });
      }
    } catch (error) {
      finish({
        sendStep: makeStep('failed', sendStartedAt, `Send failed: ${(error as Error).message}`),
        receiveStep: makeStaticStep('skipped', 'Message was not sent'),
        outcome: 'failed',
        assistantPreview: undefined,
        assistantMessageChars: 0,
        processExited,
      });
    }
  });
}

async function cleanupDiagnosticProcess(
  provider: CliProvider,
  proc: ChildProcess,
  sessionId: string,
  killProcess: KillProcess,
  wasExited: boolean,
): Promise<CliDiagnosticStep> {
  const startedAt = Date.now();
  try {
    if (!wasExited && proc.exitCode == null && proc.signalCode == null) {
      await killProcess(sessionId, proc);
    }
    provider.handleSessionExit?.(sessionId, 0);
    return makeStep('passed', startedAt);
  } catch (error) {
    return makeStep('failed', startedAt, `Cleanup failed: ${(error as Error).message}`);
  }
}

async function runProviderDiagnostic(options: {
  provider: CliProvider;
  status: CliStatusEntry;
  userId: string;
  workDir: string;
  prompt: string;
  startupTimeoutMs: number;
  responseTimeoutMs: number;
  killProcess: KillProcess;
  rawLogDir?: string;
  captureTelemetryRawLog?: boolean;
  telemetryRawLogBudget: RawLogTelemetryBudget;
}): Promise<CliDiagnosticProviderResult> {
  const {
    provider,
    status,
    userId,
    workDir,
    prompt,
    startupTimeoutMs,
    responseTimeoutMs,
    killProcess,
    rawLogDir,
  } = options;
  const startedAt = Date.now();
  const displayName = provider.getDisplayName();
  const baseSteps = {
    statusCheck: makeStaticStep('passed', status.status),
    spawn: makeStaticStep('skipped'),
    sendMessage: makeStaticStep('skipped'),
    receiveResponse: makeStaticStep('skipped'),
    cleanup: makeStaticStep('skipped'),
  };
  const smokeTrace = createSmokeTraceRecorder(status.providerId, status.environment);
  recordSmokeTraceStep(smokeTrace, 'status_check', baseSteps.statusCheck, {
    connection_status: status.status,
    provider_version: status.version ?? '',
  });

  if (status.status !== 'connected') {
    const skippedSpawnStep = makeStaticStep('skipped', `Connection status is ${status.status}`);
    recordSmokeTraceStep(smokeTrace, 'spawn', skippedSpawnStep, {
      connection_status: status.status,
    });
    recordSmokeTraceStep(smokeTrace, 'send_message', baseSteps.sendMessage, {
      prompt_kind: getDiagnosticPromptKind(prompt),
      prompt_chars: prompt.length,
    });
    recordSmokeTraceStep(smokeTrace, 'receive_assistant_message', baseSteps.receiveResponse, {
      assistant_message_chars: 0,
      process_exited: false,
    });
    recordSmokeTraceStep(smokeTrace, 'cleanup', baseSteps.cleanup);
    smokeTrace.record({
      event: 'run_completed',
      final_status: 'skipped',
      can_continue: false,
      duration_ms: Date.now() - startedAt,
    });

    return {
      providerId: status.providerId,
      displayName,
      environment: status.environment,
      connectionStatus: status.status,
      ...(status.version ? { version: status.version } : {}),
      ...(status.detectionReason ? { detectionReason: status.detectionReason } : {}),
      ...(status.commandSource ? { commandSource: status.commandSource } : {}),
      ...(status.commandShape ? { commandShape: status.commandShape } : {}),
      ...(status.versionProbe ? { versionProbe: status.versionProbe } : {}),
      ...(status.authProbe ? { authProbe: status.authProbe } : {}),
      outcome: 'skipped',
      steps: {
        ...baseSteps,
        spawn: skippedSpawnStep,
      },
      durationMs: Date.now() - startedAt,
      smokeTraceJsonl: smokeTrace.toJsonl(),
      smokeTraceEventCount: smokeTrace.count(),
    };
  }

  const sessionId = randomUUID();
  let proc: ChildProcess | null = null;
  const rawLogPath = rawLogDir
    ? path.join(
      rawLogDir,
      `${sanitizeFilePart(status.providerId)}-${sanitizeFilePart(status.environment)}.jsonl`,
    )
    : undefined;
  const rawLogWriters = [
    ...(rawLogPath ? [createRawLogWriter(rawLogPath)] : []),
    ...(options.captureTelemetryRawLog ? [createTelemetryRawLogWriter(options.telemetryRawLogBudget)] : []),
  ];
  const rawLog = rawLogWriters.length > 0
    ? createCompositeRawLogWriter(rawLogWriters)
    : createNoopRawLogWriter();
  const spawnStartedAt = Date.now();
  let spawnStep: CliDiagnosticStep;
  let spawnErrorMessage: string | undefined;
  let turnResult: DiagnosticTurnResult | null = null;
  let cleanupStep = makeStaticStep('skipped');

  try {
    const spawnResult = await provider.spawn(workDir, {
      sessionId,
      userId,
      permissionMode: 'plan',
      reasoningEffort: 'low',
      sessionMode: 'plan',
      accessMode: 'opencodeReadOnly',
      collaborationMode: 'plan',
      approvalPolicy: 'never',
      sandboxMode: 'read-only',
      startupTimeoutMs,
      rawLog: rawLog.sink,
    });

    proc = spawnResult.process;
    if (!spawnResult.ok) {
      spawnErrorMessage = spawnResult.error?.message ?? 'Provider spawn failed';
      spawnStep = makeStep('failed', spawnStartedAt, spawnErrorMessage);
    } else {
      spawnStep = makeStep('passed', spawnStartedAt);
      turnResult = await executeDiagnosticTurn(
        provider,
        proc,
        sessionId,
        prompt,
        responseTimeoutMs,
      );
    }
  } catch (error) {
    spawnErrorMessage = error instanceof Error ? error.message : String(error);
    spawnStep = makeStep('failed', spawnStartedAt, `Spawn failed: ${spawnErrorMessage}`);
  } finally {
    if (proc) {
      cleanupStep = await cleanupDiagnosticProcess(
        provider,
        proc,
        sessionId,
        killProcess,
        turnResult?.processExited ?? false,
      );
    }
    await rawLog.close();
  }

  const outcome = turnResult?.outcome ?? 'failed';
  const telemetryRawLog = rawLog.getTelemetryLog?.();
  const sendStep = turnResult?.sendStep ?? makeStaticStep(spawnStep.status === 'passed' ? 'failed' : 'skipped');
  const receiveStep = turnResult?.receiveStep ?? makeStaticStep('skipped');

  recordSmokeTraceStep(smokeTrace, 'spawn', spawnStep, {
    ...(spawnErrorMessage ? { error_message: spawnErrorMessage } : {}),
  });
  recordSmokeTraceStep(smokeTrace, 'send_message', sendStep, {
    prompt_kind: getDiagnosticPromptKind(prompt),
    prompt_chars: prompt.length,
  });
  recordSmokeTraceStep(smokeTrace, 'receive_assistant_message', receiveStep, {
    assistant_message_chars: turnResult?.assistantMessageChars ?? 0,
    process_exited: turnResult?.processExited ?? false,
  });
  recordSmokeTraceStep(smokeTrace, 'cleanup', cleanupStep);
  smokeTrace.record({
    event: 'run_completed',
    final_status: outcome,
    can_continue: outcome === 'passed',
    duration_ms: Date.now() - startedAt,
  });

  return {
    providerId: status.providerId,
    displayName,
    environment: status.environment,
    connectionStatus: status.status,
    ...(status.version ? { version: status.version } : {}),
    ...(status.detectionReason ? { detectionReason: status.detectionReason } : {}),
    ...(status.commandSource ? { commandSource: status.commandSource } : {}),
    ...(status.commandShape ? { commandShape: status.commandShape } : {}),
    ...(status.versionProbe ? { versionProbe: status.versionProbe } : {}),
    ...(status.authProbe ? { authProbe: status.authProbe } : {}),
    outcome,
    steps: {
      statusCheck: baseSteps.statusCheck,
      spawn: spawnStep,
      sendMessage: sendStep,
      receiveResponse: receiveStep,
      cleanup: cleanupStep,
    },
    durationMs: Date.now() - startedAt,
    ...(rawLogPath ? { rawLogPath } : {}),
    ...(turnResult?.assistantPreview ? { assistantPreview: turnResult.assistantPreview } : {}),
    ...(spawnErrorMessage ? { spawnErrorMessage } : {}),
    smokeTraceJsonl: smokeTrace.toJsonl(),
    smokeTraceEventCount: smokeTrace.count(),
    ...(telemetryRawLog?.jsonl ? { rawLogJsonl: telemetryRawLog.jsonl } : {}),
    ...(telemetryRawLog ? { rawLogBytes: telemetryRawLog.bytes } : {}),
    ...(telemetryRawLog ? { rawLogEventCount: telemetryRawLog.eventCount } : {}),
    ...(telemetryRawLog ? { rawLogTruncated: telemetryRawLog.truncated } : {}),
  };
}

export async function runCliDiagnostics(
  userId: string,
  options: RunCliDiagnosticsOptions = {},
): Promise<CliDiagnosticReport> {
  const registry = options.registry ?? cliProviderRegistry;
  const environment = options.environment ?? await getAgentEnvironment(userId);
  const statuses = options.statusEntries ?? await getCliStatusSnapshot({ force: true, userId });
  const workDir = await resolveDiagnosticWorkDir(options.workDir);
  const prompt = options.prompt ?? DEFAULT_DIAGNOSTIC_PROMPT;
  const reportId = randomUUID();
  const generatedAt = (options.now?.() ?? new Date()).toISOString();
  const rawLogDir = options.writeRawLogs === false
    ? undefined
    : await resolveRawLogDir(reportId, generatedAt);
  const telemetryRawLogBudget: RawLogTelemetryBudget = {
    remainingBytes: TELEMETRY_RAW_LOG_MAX_REPORT_BYTES,
    isTruncated: false,
  };
  const providers: CliDiagnosticProviderResult[] = [];

  for (const providerId of registry.getProviderIds()) {
    const provider = registry.getProvider(providerId);
    const status = getStatusForEnvironment(statuses, providerId, environment);
    providers.push(await runProviderDiagnostic({
      provider,
      status,
      userId,
      workDir,
      prompt,
      startupTimeoutMs: options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS,
      responseTimeoutMs: options.responseTimeoutMs ?? DEFAULT_RESPONSE_TIMEOUT_MS,
      killProcess: options.killProcess ?? gracefulKillProcess,
      rawLogDir,
      captureTelemetryRawLog: options.captureTelemetryRawLog,
      telemetryRawLogBudget,
    }));
  }

  const report: CliDiagnosticReport = {
    schemaVersion: 1,
    id: reportId,
    generatedAt,
    environment,
    prompt,
    ...(rawLogDir ? { rawLogDir } : {}),
    summary: summarizeProviders(providers),
    providers,
  };

  if (options.storeLatest !== false) {
    getLatestReportStore().byUserId.set(userId, stripTelemetryRawLogs(report));
  }

  return report;
}

export function stripTelemetryRawLogs(report: CliDiagnosticReport): CliDiagnosticReport {
  return {
    ...report,
    providers: report.providers.map((provider) => {
      const {
        rawLogJsonl: _rawLogJsonl,
        rawLogBytes: _rawLogBytes,
        rawLogEventCount: _rawLogEventCount,
        rawLogTruncated: _rawLogTruncated,
        ...safeProvider
      } = provider;
      return safeProvider;
    }),
  };
}

export function getLatestCliDiagnosticReport(userId: string): CliDiagnosticReport | null {
  return getLatestReportStore().byUserId.get(userId) ?? null;
}

function escapeMarkdownCell(value: string | number | undefined): string {
  return String(value ?? '')
    .replace(/\|/g, '\\|')
    .replace(/\n/g, ' ');
}

export function renderCliDiagnosticMarkdown(report: CliDiagnosticReport): string {
  const rows = report.providers.map((provider) => [
    provider.displayName,
    provider.environment,
    provider.connectionStatus,
    provider.outcome,
    `${provider.durationMs}ms`,
    provider.rawLogPath,
    provider.steps.receiveResponse.message ?? provider.steps.spawn.message ?? '',
  ]);

  return [
    '# Tessera CLI Diagnostics',
    '',
    `- Report ID: ${report.id}`,
    `- Generated at: ${report.generatedAt}`,
    `- Environment: ${report.environment}`,
    `- Prompt: ${report.prompt}`,
    `- Summary: ${report.summary.passed} passed, ${report.summary.failed} failed, ${report.summary.timeout} timeout, ${report.summary.skipped} skipped`,
    '',
    `- Raw log directory: ${report.rawLogDir ?? 'not captured'}`,
    '',
    '| Provider | Environment | CLI Status | Outcome | Duration | Raw Log | Message |',
    '| --- | --- | --- | --- | ---: | --- | --- |',
    ...rows.map((row) => `| ${row.map(escapeMarkdownCell).join(' | ')} |`),
    '',
  ].join('\n');
}

export async function exportCliDiagnosticReport(
  report: CliDiagnosticReport,
): Promise<CliDiagnosticExportResult> {
  const exportDir = getTesseraDataPath('diagnostic-reports');
  await fs.mkdir(exportDir, { recursive: true, mode: 0o700 });

  const baseName = `cli-diagnostics-${formatTimestampForFilename(report.generatedAt)}-${report.id.slice(0, 8)}`;
  const jsonPath = path.join(exportDir, `${baseName}.json`);
  const markdownPath = path.join(exportDir, `${baseName}.md`);

  await Promise.all([
    fs.writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 }),
    fs.writeFile(markdownPath, renderCliDiagnosticMarkdown(report), { encoding: 'utf8', mode: 0o600 }),
  ]);

  return {
    reportId: report.id,
    jsonPath,
    markdownPath,
    rawLogDir: report.rawLogDir ?? '',
  };
}

export async function exportLatestCliDiagnosticReport(
  userId: string,
): Promise<CliDiagnosticExportResult> {
  const report = getLatestCliDiagnosticReport(userId);
  if (!report) {
    throw new Error('No diagnostic report found');
  }
  return exportCliDiagnosticReport(report);
}
