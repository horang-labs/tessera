import type { ChildProcess } from 'child_process';
import type { SessionHistoryEvent } from '@/lib/session-replay-types';
import type { ProviderRuntimeControls } from '@/lib/session/session-control-types';
import type { ProviderRateLimitsSnapshot } from '@/lib/status-display/types';
import type { ContentBlock } from '@/lib/ws/message-types';
import type { CliEnvironment } from '../cli-exec';
import type { ParsedMessage } from './message-types';
import type {
  GeneratedText,
  GeneratedTitle,
  SpawnOptions,
  SpawnResult,
  TranslatedText,
} from './session-types';
import type { SkillSource } from './skill-types';
import type { ProviderHomeIdentity } from './provider-home-identity';

export type { ProviderHomeIdentity } from './provider-home-identity';

/**
 * Three-state connection status for a given CLI × environment combination.
 *  - "connected":     binary runs AND auth check succeeds
 *  - "needs_login":   binary runs but auth check fails
 *  - "not_installed": binary missing OR execution failed (ENOENT, timeout, non-zero)
 */
export type CliConnectionStatus = 'connected' | 'needs_login' | 'not_installed';

export type CliDetectionReason =
  | 'connected'
  | 'auth_failed'
  | 'auth_timeout'
  | 'binary_missing'
  | 'permission_denied'
  | 'version_timeout'
  | 'version_nonzero'
  | 'override_failed'
  | 'wrong_environment'
  | 'unknown';

export type CliProbeFailureKind = 'ok' | 'spawn_error' | 'timeout' | 'nonzero_exit' | 'unknown';

export type CliCommandSource = 'default' | 'override';
export type CliCommandShape = 'bare_command' | 'absolute_path' | 'relative_path' | 'other';

/** How a provider TUI reacts when the host terminal changes light/dark mode. */
export type TerminalAppearanceChangePolicy = 'live' | 'restart';

/** How a provider TUI uses ED3 while redrawing after SIGWINCH. */
export type TerminalResizeScrollbackPolicy = 'native' | 'preserve-on-ed3';

/** How accepted terminal input indicates an agent-turn interrupt. */
export type TerminalInterruptInputPolicy = 'none' | 'single-escape';

/** Provider-specific requirements consumed by the shared integration policy. */
export interface ProviderIntegrationRequirements {
  lifecycle: 'required' | 'not-applicable';
  skill: 'required' | 'optional' | 'not-applicable';
  launchEnvironment: 'required' | 'not-applicable';
}

export interface ProviderLifecycleContext {
  environment: CliEnvironment;
  userId?: string;
  workDir?: string | null;
  /** Internal launch-time scope identity used to keep active health checks pinned. */
  scopeId?: string;
}

export type ProviderLifecycleState = 'absent' | 'installed' | 'stale' | 'conflict' | 'unavailable';
export type ProviderLifecycleTrust = 'unchecked' | 'trusted' | 'untrusted' | 'unavailable';
export type ProviderLifecycleConsent = 'granted' | 'revoked' | 'not-granted';

export interface ProviderLifecycleResult {
  state: ProviderLifecycleState;
  trust: ProviderLifecycleTrust;
  consent?: ProviderLifecycleConsent;
  installedVersion?: string;
  currentVersion?: string;
  /** Internal identity for one Authoritative Provider Home; never expose in UI/CLI DTOs. */
  scopeId?: string;
  message?: string;
  guidance?: {
    minimumVersion: string;
    updateCommand: string;
    message: string;
  };
}

export interface ProviderLifecycleIntegration {
  inspect(context: ProviderLifecycleContext): Promise<ProviderLifecycleResult>;
  install(context: ProviderLifecycleContext): Promise<ProviderLifecycleResult>;
  /** Refreshes a consented artifact, including explicit conflict resolution. */
  update?(context: ProviderLifecycleContext): Promise<ProviderLifecycleResult>;
  /**
   * Removes the managed artifact from this Authoritative Provider Home and revokes
   * automatic management consent for that home. This is not an all-home uninstall.
   */
  remove?(context: ProviderLifecycleContext): Promise<ProviderLifecycleResult>;
  /** Refreshes a consented artifact before launch without resolving conflicts. */
  maintain?(context: ProviderLifecycleContext): Promise<ProviderLifecycleResult>;
}

export type ProviderLaunchEnvironmentContext = ProviderLifecycleContext;

export interface ProviderSessionRuntimeGuard {
  /** Repeat the provider-owned preflight immediately before process spawn. */
  reinspect(): Promise<ProviderSessionResumeInspection>;
  /** Monitor ownership from spawn until the returned disposer is called. */
  start(onConflict: (message: string) => void): Promise<() => void>;
}

export type ProviderSessionResumeInspection =
  | { state: 'available'; runtimeGuard?: ProviderSessionRuntimeGuard }
  | {
      state: 'unavailable';
      reason: 'provider-history-missing' | 'provider-session-already-running';
      message: string;
    };

/** Provider-owned launch authority resolved once for lifecycle and process environment. */
export interface ProviderLaunchPreparation {
  /** Opaque stable identity; callers can compare it but cannot recover the home path. */
  providerHomeIdentity?: ProviderHomeIdentity;
  lifecycle?: ProviderLifecycleIntegration;
  buildEnvironment(baseEnvironment: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
  /** Read-only existence/liveness check pinned to the exact prepared home. */
  inspectResume?(providerSessionId: string): Promise<ProviderSessionResumeInspection>;
  /** Read provider-owned history from the exact prepared home before resume. */
  readResumeHistory?(providerSessionId: string): Promise<SessionHistoryEvent[] | null>;
}

export interface ProviderTerminalSessionObservation {
  activation: 'active' | 'background';
  providerSessionId: string;
  transcriptPath?: string;
  /**
   * Where this conversation runs, as the CLI itself names it — a fork may leave
   * the parent's directory behind. Callers must translate it through
   * `resolveAgentReportedPath` before opening or storing it.
   */
  workDir?: string;
}

export interface ProviderTerminalSessionObserver {
  ready(): Promise<void>;
  dispose(): void;
}

export interface ProviderTerminalSessionObserverOptions {
  currentProviderSessionId: () => string | undefined;
  onObservation: (observation: ProviderTerminalSessionObservation) => void;
  /**
   * Whose CLI this is. Decides which filesystem the provider's artifacts live
   * on; omitting it resolves to `native`, which across a bridge watches the
   * server's own home instead of the agent's.
   */
  userId?: string;
}

export interface CliProbeSummary {
  ok: boolean;
  failureKind: CliProbeFailureKind;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  spawnErrorCode?: string;
}

export interface CliCommandTelemetry {
  commandSource: CliCommandSource;
  commandShape: CliCommandShape;
}

/**
 * Result of a single connection check for one CLI × environment.
 */
export interface CliStatusResult {
  status: CliConnectionStatus;
  /** CLI version string when available (omitted when not_installed). */
  version?: string;
  detectionReason?: CliDetectionReason;
  commandSource?: CliCommandSource;
  commandShape?: CliCommandShape;
  versionProbe?: CliProbeSummary;
  authProbe?: CliProbeSummary;
}

/**
 * Input to CliProvider.checkStatus().
 */
export interface CheckStatusOptions {
  /**
   * "native" = spawn directly on the host.
   * "wsl"    = spawn through wsl.exe on Windows. Ignored on non-Windows.
   */
  environment: 'native' | 'wsl';
  /** Optional user id for settings-aware CLI command overrides. */
  userId?: string;
}

export interface ProviderRateLimitOptions {
  environment: CliEnvironment;
}

/**
 * CliProvider is the primary abstraction for plugging in different coding-agent
 * CLIs (Claude, Codex, Gemini, OpenCode, etc.).
 *
 * Each provider encapsulates:
 * - How to spawn the CLI process with the correct arguments
 * - How to write user messages to the CLI's stdin
 * - How to parse lines from the CLI's stdout into WebSocket messages
 * - How to generate a session title from a conversation prompt
 *
 * Callers program against this interface and never import CLI-specific
 * implementation details directly.
 */
export interface CliProvider {
  /**
   * Returns the unique machine-readable identifier for this CLI provider.
   * Must match the ID used when registering the provider in the registry.
   */
  getProviderId(): string;

  /** Declares provider-specific integration requirements without filesystem details. */
  getProviderIntegrationRequirements(): ProviderIntegrationRequirements;

  /** Whether managed sessions remain bound to the provider home that created them. */
  bindsManagedSessionsToProviderHome?(): boolean;

  /** Implements provider-owned lifecycle artifact management behind this provider seam. */
  getLifecycleIntegration?(): ProviderLifecycleIntegration;

  /** Resolves the provider-owned home where global discovery skills live. */
  resolveSkillHome?(environment: CliEnvironment): Promise<string>;

  /** Resolves one provider-owned launch authority without exposing its home path. */
  prepareLaunchIntegration?(
    context: ProviderLaunchEnvironmentContext,
  ): Promise<ProviderLaunchPreparation>;

  /**
   * Returns the human-readable display name for this CLI provider.
   * Used in UI dropdowns and log messages.
   */
  getDisplayName(): string;

  /**
   * Declares whether an already-running TUI can follow the terminal's
   * standardized color-scheme notification or must be resumed after restart.
   */
  getTerminalAppearanceChangePolicy(): TerminalAppearanceChangePolicy;

  /** Declares whether SIGWINCH redraw ED3 must preserve host scrollback. */
  getTerminalResizeScrollbackPolicy(): TerminalResizeScrollbackPolicy;

  /** Declares whether one accepted Escape interrupts the active terminal turn. */
  getTerminalInterruptInputPolicy(): TerminalInterruptInputPolicy;

  /**
   * Interprets provider-owned persisted state to decide whether terminating a
   * PTY can be followed by a lossless resume of the same provider session.
   */
  canResumeTerminalAfterRestart?(providerState: string | null): boolean;

  /** Watches provider-owned artifacts for native CLI session forks. */
  createTerminalSessionObserver?(
    options: ProviderTerminalSessionObserverOptions,
  ): ProviderTerminalSessionObserver;

  /**
   * Replays a terminal (PTY) session's provider-owned transcript as Tessera
   * history events, so a conversation that never streamed through ProcessManager
   * can still render in the chat view. Read-only: implementations MUST NOT write
   * to the transcript or mutate session state.
   *
   * Returns null when the provider cannot locate a transcript for the session —
   * distinct from an empty array, which means "found it, nothing to show yet".
   */
  readTerminalTranscriptEvents?(options: {
    /** Tessera session id — used for tool-result asset URLs. */
    sessionId: string;
    /** The provider's own session id for this PTY session. */
    providerSessionId: string;
    /** Hook-reported transcript path, when one was captured. */
    transcriptPath?: string | null;
    /**
     * Owner of the session. Providers that shell out must resolve the user's
     * agent environment (native vs. WSL) from it — running the CLI on the wrong
     * side reads a different machine's data and reports the session missing.
     */
    userId?: string;
  }): Promise<SessionHistoryEvent[] | null>;

  /**
   * Cheap identity of whatever `readTerminalTranscriptEvents` would return, used
   * to decide whether a cached decode is still valid.
   *
   * Providers own this because the backing store differs: a rollout file can be
   * stat'ed, while OpenCode keeps conversations in SQLite and has no path to
   * stat at all. MUST be much cheaper than the read itself — for OpenCode the
   * read costs a CLI invocation, so skipping it is the whole point.
   *
   * Return null when identity cannot be established; callers then treat the
   * result as uncacheable rather than serving a stale decode.
   */
  readTerminalTranscriptFingerprint?(options: {
    providerSessionId: string;
    transcriptPath?: string | null;
    userId?: string;
  }): Promise<string | null>;

  /**
   * Classifies a provider hook that may belong to a non-active fork child.
   * Returns the child's own details when it is one — `workDir` when the fork
   * runs somewhere other than the parent — and null when it is not.
   *
   * Async because the answer lives in a file the CLI wrote, which across a
   * bridge sits on the agent's filesystem and takes a probe to locate.
   */
  resolveBackgroundTerminalSessionFork?(options: {
    currentProviderSessionId: string;
    observedProviderSessionId: string;
    userId?: string;
  }): Promise<{ workDir?: string } | null>;

  /**
   * Recognizes, from what the PTY currently shows, that the running conversation
   * was reset in place (`/clear`, `/new`). Codex and OpenCode mint the next
   * session id lazily — nothing is reported until the next prompt — so the
   * screen is the only signal available at the moment it happens, and it is
   * independent of how the command was issued (typed, completed, or picked).
   */
  detectTerminalConversationReset?(options: {
    visibleText: string;
    currentProviderSessionId: string;
  }): boolean;

  /**
   * Checks whether this CLI binary is available in the requested environment
   * ("native" host vs. "wsl"). When omitted, implementations fall back to a
   * same-host binary probe.
   */
  isAvailable(environment?: 'native' | 'wsl'): Promise<boolean>;

  /** Reads account-wide usage limits without requiring a provider session. */
  fetchRateLimits?(
    options: ProviderRateLimitOptions,
  ): Promise<ProviderRateLimitsSnapshot | null>;

  /**
   * Returns the CLI arguments to pass to spawn() for the given options.
   * Does NOT include the binary name itself.
   */
  getCliArgs(options: SpawnOptions): string[];

  /**
   * Spawns the CLI process in the given working directory.
   */
  spawn(workDir: string, options: SpawnOptions): Promise<SpawnResult>;

  /**
   * Writes a user message to the CLI process stdin in whatever format the
   * CLI expects.
   */
  sendMessage(proc: ChildProcess, content: string | ContentBlock[]): boolean;

  /**
   * Parses a single newline-delimited stdout line from the CLI process.
   *
   * The parser MUST be pure: no direct calls to processManager, WebSocket
   * send, or any I/O. Side effects are described via ParsedMessage.sideEffect
   * and executed by the caller.
   */
  parseStdout(line: string): ParsedMessage | null;

  /**
   * Optional session-aware stdout parser.
   *
   * Use this when the provider needs the Tessera session ID to resolve parser
   * state or protocol bookkeeping.
   */
  parseSessionStdout?(sessionId: string, line: string): ParsedMessage[];

  /**
   * Optional exit hook for provider-owned parser/session cleanup.
   * Called on every process exit.
   */
  handleSessionExit?(sessionId: string, exitCode: number): ParsedMessage[];

  /**
   * Generates a semantic title for a session from the initial prompt text.
   *
   * This carries the *title* contract — providers may add a title-shaped system
   * prompt and clamp the reply to a title's length. Callers that want a
   * general-purpose one-shot answer want `generateText`.
   */
  generateTitle(prompt: string, userId?: string): Promise<GeneratedTitle | null>;

  /**
   * Runs a caller-built prompt through the provider's one-shot headless path
   * and returns the model's raw reply, with no system prompt of the provider's
   * own and no length clamp. The same spawn primitive `generateTitle` uses, so
   * a session's running agent is neither consulted nor delayed.
   * Optional — providers without a headless path may omit it; callers must
   * handle its absence.
   */
  generateText?(prompt: string, userId?: string): Promise<GeneratedText | null>;

  /**
   * Translates the given (pre-built) prompt's text via a one-shot CLI call.
   * Mirrors generateTitle: the caller builds the full instruction prompt; the
   * provider runs it headless and returns the model's raw response text.
   * `model` optionally overrides the model used for this one-shot translation.
   * Optional — providers that cannot translate one-shot (or are unconfigured)
   * may omit it; callers must fail-open when absent.
   */
  translateText?(prompt: string, userId?: string, model?: string): Promise<TranslatedText | null>;

  /**
   * Optional: update provider-side session configuration for future turns.
   */
  updateSessionConfig?(
    proc: ChildProcess,
    patch: ProviderRuntimeControls & {
      permissionMode?: string;
      model?: string;
      reasoningEffort?: string | null;
    },
  ): boolean;

  /**
   * Optional: send an approval response to the CLI process for a pending
   * server-initiated request.
   */
  sendApprovalResponse?(proc: ChildProcess, requestId: string, decision: 'accept' | 'decline'): void;

  /**
   * Optional: send a raw JSON-RPC result to the CLI process for a
   * provider-specific server-initiated request.
   */
  sendJsonRpcResponse?(proc: ChildProcess, requestId: string, result: Record<string, unknown>): void;

  /**
   * Optional: send a raw JSON-RPC error to the CLI process for an unsupported
   * provider-specific server-initiated request.
   */
  sendJsonRpcError?(
    proc: ChildProcess,
    requestId: string,
    error: { code: number; message: string; data?: unknown },
  ): void;

  /**
   * Optional: send an interrupt/cancel signal to the CLI process.
   */
  sendInterrupt?(proc: ChildProcess, sessionId: string): boolean;

  /**
   * Optional: start provider-native context compaction for the session.
   */
  compactThread?(proc: ChildProcess, sessionId: string): Promise<boolean>;

  /**
   * Optional: create a SkillSource bound to a specific session's CLI process.
   */
  createSkillSource?(sessionId: string, proc: ChildProcess): SkillSource | null;

  /**
   * Optional: drain provider-owned messages captured before ProcessManager
   * attaches its stdout handler.
   */
  consumeStartupMessages?(proc: ChildProcess, sessionId: string): ParsedMessage[];

  /**
   * Optional: run provider-specific startup requests after the process has
   * been registered and stdout/stderr handlers are attached.
   */
  onSessionReady?(proc: ChildProcess, sessionId: string): boolean;

  /**
   * Runs provider-specific commands to report whether the CLI is installed,
   * runnable, and logged in for the given environment.
   *
   * Implementations SHOULD:
   *  - bail out to "not_installed" when the version command fails
   *  - return "needs_login" when version succeeds but auth fails
   *  - enforce a 5s timeout per command
   *
   * This method is read-only: it MUST NOT persist state, mutate sessions, or
   * write to any other subsystem.
   */
  checkStatus(options: CheckStatusOptions): Promise<CliStatusResult>;
}
