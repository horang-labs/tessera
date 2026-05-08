import type { ChildProcess } from 'child_process';
import type { ProviderRuntimeControls } from '@/lib/session/session-control-types';
import type { ContentBlock } from '@/lib/ws/message-types';
import type { ParsedMessage } from './message-types';
import type { GeneratedTitle, SpawnOptions, SpawnResult } from './session-types';
import type { SkillSource } from './skill-types';

/**
 * Three-state connection status for a given CLI × environment combination.
 *  - "connected":     binary runs AND auth check succeeds
 *  - "needs_login":   binary runs but auth check fails
 *  - "not_installed": binary missing OR execution failed (ENOENT, timeout, non-zero)
 */
export type CliConnectionStatus = 'connected' | 'needs_login' | 'not_installed';

/**
 * Result of a single connection check for one CLI × environment.
 */
export interface CliStatusResult {
  status: CliConnectionStatus;
  /** CLI version string when available (omitted when not_installed). */
  version?: string;
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

  /**
   * Returns the human-readable display name for this CLI provider.
   * Used in UI dropdowns and log messages.
   */
  getDisplayName(): string;

  /**
   * Checks whether this CLI binary is available in the requested environment
   * ("native" host vs. "wsl"). When omitted, implementations fall back to a
   * same-host binary probe.
   */
  isAvailable(environment?: 'native' | 'wsl'): Promise<boolean>;

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
   */
  generateTitle(prompt: string, userId?: string): Promise<GeneratedTitle | null>;

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
