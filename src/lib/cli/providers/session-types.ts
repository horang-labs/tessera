import type { ChildProcess } from 'child_process';
import type { ProviderRuntimeControls } from '@/lib/session/session-control-types';

export interface ManagedCliLaunch {
  environment: Record<string, string | undefined>;
  guestEnvironment: Record<string, string | undefined>;
  skillOverlay?: {
    rootDir: string;
    skillsDir: string;
  };
}

export type CliRawLogDirection = 'stdin' | 'stdout' | 'stderr' | 'event';

export interface CliRawLogEvent {
  direction: CliRawLogDirection;
  phase: string;
  data: string;
}

export type CliRawLogSink = (event: CliRawLogEvent) => void;

/**
 * Options passed to the provider when creating or resuming a CLI session.
 */
export interface SpawnOptions extends ProviderRuntimeControls {
  /** Session-scoped Tessera skill/bridge resources prepared by ProcessManager. */
  managedLaunch?: ManagedCliLaunch;
  /** Optional user id for settings-aware spawn behavior such as WSL/native selection. */
  userId?: string;
  /** Permission mode for tool execution (CLI-specific interpretation). */
  permissionMode?: string;
  /** Model identifier to use for this session. */
  model?: string;
  /** Optional provider-specific reasoning effort / thinking intensity. */
  reasoningEffort?: string | null;
  /**
   * Session ID for this spawn. Semantics depend on the `resume` flag:
   * - When `resume` is true: the provider should resume an existing session
   *   (e.g. --resume <sessionId>).
   * - When `resume` is false/absent: this is a new session and the provider
   *   should pass the ID as a session-creation hint (e.g. --session-id <id>),
   *   so the CLI's session ID matches the Tessera's UUID.
   */
  sessionId?: string;
  /**
   * When true, the provider should resume an existing CLI session identified
   * by `sessionId`. When false or absent, a new session is started and
   * `sessionId` (if provided) is used as the desired session ID.
   */
  resume?: boolean;
  /**
   * Codex: the threadId from a prior thread/start response, stored in
   * sessions.provider_state as {"threadId": "..."}.
   */
  threadId?: string;
  /**
   * OpenCode: ACP sessionId from session/new, stored in sessions.provider_state
   * as {"opencodeSessionId": "..."}.
   */
  opencodeSessionId?: string;
  /**
   * Optional provider startup/handshake timeout override. Regular sessions use
   * provider defaults; diagnostics pass a shorter timeout so settings checks do
   * not hang for minutes.
   */
  startupTimeoutMs?: number;
  /**
   * Optional raw CLI I/O sink. Used by diagnostics to persist provider-level
   * stdin/stdout/stderr without changing normal session behavior.
   */
  rawLog?: CliRawLogSink;
}

/**
 * Result returned from CliProvider.spawn().
 */
export interface SpawnResult {
  /** The spawned child process. */
  process: ChildProcess;
  /** Whether the process spawned successfully. */
  ok: boolean;
  /** Error if spawning failed (ok === false). */
  error?: Error;
}

/**
 * Three-state connection status for a CLI provider.
 * - "connected":     binary runs AND auth check succeeds
 * - "needs_login":   binary runs but user is not logged in
 * - "not_installed": binary missing or execution failed
 */
export type ProviderConnectionStatus = 'connected' | 'needs_login' | 'not_installed';

/**
 * Metadata about a CLI provider, used for display and availability checks.
 */
export interface ProviderMeta {
  /** Unique provider identifier (e.g. "claude", "codex", "gemini"). */
  id: string;
  /** Human-readable display name (e.g. "Claude Code CLI"). */
  displayName: string;
  /**
   * Convenience flag that mirrors `status === 'connected'`.
   * UI callers that only care about "fully usable" can read this directly.
   */
  available: boolean;
  /** Fine-grained connection status. Undefined on registries that never probed. */
  status?: ProviderConnectionStatus;
  /** CLI version string when available (from `--version` output). */
  version?: string;
}

/**
 * Result of CliProvider.generateTitle().
 */
export interface GeneratedTitle {
  /** Short human-readable title (max ~30 chars, same language as conversation). */
  title: string;
}

/**
 * Result of CliProvider.translateText().
 */
export interface TranslatedText {
  /** Translated text in the requested target language. */
  text: string;
}

/**
 * Result of CliProvider.generateText().
 */
export interface GeneratedText {
  /** The model's reply, exactly as it arrived. */
  text: string;
}

/** Additive v1 Autorun capability; no worker/title/translation method changes. */
export type AnalysisSnapshotRequest = {
  userId: string;
  agentEnvironment: 'native' | 'wsl';
  sessionId: string;
  providerConversationId: string;
  expectedBoundary: import('@/lib/automation/runtime-port').Boundary;
  inputEpoch: string;
  workerSelection: import('@/lib/automation/contracts').SessionSelectionSnapshot;
  correlation: import('@/lib/automation/autorun-contracts').ProviderTurnCorrelation;
  signal: AbortSignal;
};
export type SupervisorCapabilityRequest = {
  userId: string; agentEnvironment: 'native' | 'wsl';
  selection: import('@/lib/automation/autorun-contracts').SupervisorSelection;
};
export type SupervisorDecisionRequest = SupervisorCapabilityRequest & {
  invocationId: string;
  trustedInstructions: string;
  packet: import('@/lib/automation/autorun-contracts').SupervisorPacket;
  outputSchema: typeof import('@/lib/automation/autorun-contracts').SUPERVISOR_DECISION_JSON_SCHEMA;
  deadlineAt: number;
  signal: AbortSignal;
};
export type SupervisorSettlementObservationRequest = {
  version: 1; userId: string; agentEnvironment: 'native' | 'wsl'; invocationId: string;
};
export interface AutorunProviderPort {
  readonly version: 1;
  /** R1-owned verified human objective/corrections and current submit evidence; no completed snapshot required. */
  readAutorunEvidence(args: AutorunEvidenceRequest): Promise<import('@/lib/automation/autorun-contracts').AutorunEvidenceResult>;
  /** Provider-owned bounded native read; owner/environment always explicit. */
  readAnalysisContext(args: AnalysisSnapshotRequest): Promise<import('@/lib/automation/autorun-contracts').AnalysisContextResult>;
  /** Fresh installed metadata/policy attestation, no model call. */
  checkSupervisorCapability(args: SupervisorCapabilityRequest): Promise<import('@/lib/automation/autorun-contracts').SupervisorCapabilityResult>;
  /** Fresh auth-only, tool-free process; signal stops only its owned tree, then proves quiescence. */
  generateSupervisorDecision(args: SupervisorDecisionRequest): Promise<import('@/lib/automation/autorun-contracts').SupervisorResult>;
  /** Read/reconcile exact durable ownership + all-process settlement; no inference, output replay or kill.
   * Absence/unknown retains analysis capacity quarantine; worker input ownership is handled separately by R2.
   */
  observeSupervisorSettlement?(args: SupervisorSettlementObservationRequest): Promise<import('@/lib/automation/autorun-contracts').SupervisorSettlementObservation>;
}

/** R2 captures current native association under its gate, then asks R1 for provenance without a model call.
 * Completed context is deliberately unnecessary for an accepted first running turn.
 */
export type AutorunEvidenceRequest = {
  userId: string; agentEnvironment: 'native' | 'wsl'; sessionId: string; providerConversationId: string;
  inputEpoch: string; workerSelection: import('@/lib/automation/contracts').SessionSelectionSnapshot;
  turnEvidence: import('@/lib/automation/autorun-contracts').AutorunTurnEvidence;
  goalRevision: number; previousHumanSourceIds: readonly string[]; signal: AbortSignal;
};
