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
}

interface DiagnosticTurnResult {
  sendStep: CliDiagnosticStep;
  receiveStep: CliDiagnosticStep;
  outcome: CliDiagnosticStepStatus;
  assistantPreview?: string;
  processExited: boolean;
}

interface RawLogWriter {
  path: string;
  sink: CliRawLogSink;
  close: () => Promise<void>;
}

interface LatestReportStore {
  byUserId: Map<string, CliDiagnosticReport>;
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
          processExited,
        });
      }
    } catch (error) {
      finish({
        sendStep: makeStep('failed', sendStartedAt, `Send failed: ${(error as Error).message}`),
        receiveStep: makeStaticStep('skipped', 'Message was not sent'),
        outcome: 'failed',
        assistantPreview: undefined,
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
  rawLogDir: string;
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

  if (status.status !== 'connected') {
    return {
      providerId: status.providerId,
      displayName,
      environment: status.environment,
      connectionStatus: status.status,
      ...(status.version ? { version: status.version } : {}),
      outcome: 'skipped',
      steps: {
        ...baseSteps,
        spawn: makeStaticStep('skipped', `Connection status is ${status.status}`),
      },
      durationMs: Date.now() - startedAt,
    };
  }

  const sessionId = randomUUID();
  let proc: ChildProcess | null = null;
  const rawLogPath = path.join(
    rawLogDir,
    `${sanitizeFilePart(status.providerId)}-${sanitizeFilePart(status.environment)}.jsonl`,
  );
  const rawLog = createRawLogWriter(rawLogPath);
  const spawnStartedAt = Date.now();
  let spawnStep: CliDiagnosticStep;
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
      spawnStep = makeStep('failed', spawnStartedAt, spawnResult.error?.message ?? 'Provider spawn failed');
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
    spawnStep = makeStep('failed', spawnStartedAt, `Spawn failed: ${(error as Error).message}`);
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

  return {
    providerId: status.providerId,
    displayName,
    environment: status.environment,
    connectionStatus: status.status,
    ...(status.version ? { version: status.version } : {}),
    outcome,
    steps: {
      statusCheck: baseSteps.statusCheck,
      spawn: spawnStep,
      sendMessage: turnResult?.sendStep ?? makeStaticStep(spawnStep.status === 'passed' ? 'failed' : 'skipped'),
      receiveResponse: turnResult?.receiveStep ?? makeStaticStep('skipped'),
      cleanup: cleanupStep,
    },
    durationMs: Date.now() - startedAt,
    rawLogPath,
    ...(turnResult?.assistantPreview ? { assistantPreview: turnResult.assistantPreview } : {}),
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
  const rawLogDir = await resolveRawLogDir(reportId, generatedAt);
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
    }));
  }

  const report: CliDiagnosticReport = {
    schemaVersion: 1,
    id: reportId,
    generatedAt,
    environment,
    prompt,
    rawLogDir,
    summary: summarizeProviders(providers),
    providers,
  };

  if (options.storeLatest !== false) {
    getLatestReportStore().byUserId.set(userId, report);
  }

  return report;
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
    `- Raw log directory: ${report.rawLogDir}`,
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
    rawLogDir: report.rawLogDir,
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
