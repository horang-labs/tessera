import type {
  CliCommandShape,
  CliCommandSource,
  CliConnectionStatus,
  CliDetectionReason,
  CliProbeSummary,
} from './providers/provider-contract';
import type { AgentEnvironment } from '@/lib/settings/types';

export type CliDiagnosticStepStatus = 'passed' | 'failed' | 'skipped' | 'timeout';
export type CliDiagnosticOutcome = CliDiagnosticStepStatus;

export interface CliDiagnosticStep {
  status: CliDiagnosticStepStatus;
  durationMs?: number;
  message?: string;
}

export interface CliDiagnosticProviderResult {
  providerId: string;
  displayName: string;
  environment: AgentEnvironment;
  connectionStatus: CliConnectionStatus;
  version?: string;
  detectionReason?: CliDetectionReason;
  commandSource?: CliCommandSource;
  commandShape?: CliCommandShape;
  versionProbe?: CliProbeSummary;
  authProbe?: CliProbeSummary;
  outcome: CliDiagnosticOutcome;
  steps: {
    statusCheck: CliDiagnosticStep;
    spawn: CliDiagnosticStep;
    sendMessage: CliDiagnosticStep;
    receiveResponse: CliDiagnosticStep;
    cleanup: CliDiagnosticStep;
  };
  durationMs: number;
  assistantPreview?: string;
  spawnErrorMessage?: string;
  smokeTraceJsonl?: string;
  smokeTraceEventCount?: number;
  rawLogPath?: string;
  rawLogJsonl?: string;
  rawLogBytes?: number;
  rawLogEventCount?: number;
  rawLogTruncated?: boolean;
}

export interface CliDiagnosticReport {
  schemaVersion: 1;
  id: string;
  generatedAt: string;
  environment: AgentEnvironment;
  prompt: string;
  rawLogDir?: string;
  summary: {
    passed: number;
    failed: number;
    skipped: number;
    timeout: number;
    total: number;
  };
  providers: CliDiagnosticProviderResult[];
}

export interface CliDiagnosticExportResult {
  reportId: string;
  jsonPath: string;
  markdownPath: string;
  rawLogDir: string;
}
