import type { ChildProcess } from 'child_process';
import type { ProviderRuntimeControls } from '@/lib/session/session-control-types';

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
