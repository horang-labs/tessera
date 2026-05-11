/**
 * Session Management Types
 *
 * Shared types for session orchestration and metadata storage.
 */

import type { ActiveInteractivePrompt, EnhancedMessage, SessionStatus } from '@/types/chat';
import type { PersistedContextUsage, PersistedUsage } from '@/lib/session-replay-types';
import type { ProviderRuntimeControls } from '@/lib/session/session-control-types';

export interface SessionMetadataRecord {
  /** Unique session identifier (UUID v4) */
  id: string;

  /** User-friendly session title (editable) */
  title: string;

  /** CLI's internal session ID */
  cliSessionId: string;

  /** Current session status */
  status: SessionStatus;

  /** ISO 8601 timestamp of session creation */
  createdAt: string;

  /** ISO 8601 timestamp of last activity */
  lastActiveAt: string;

  /** Cached message count */
  messageCount: number;

  /** Working directory for CLI process */
  workDir: string;

  /** Unread message count (for FEAT-002) */
  unreadCount?: number;
}

/**
 * Result of session creation
 */
export interface SessionCreateResult {
  sessionId: string;
  title: string;
  status: SessionStatus;
  createdAt: string;
  cliSessionId: string;
  projectDir: string;
  /** CLI provider ID used for this session (e.g. 'claude-code', 'codex'). */
  provider?: string;
}

/**
 * Result of session resume
 *
 * status: 'running'   — CLI process was spawned successfully, live session active
 * status: 'read_only' — CLI spawn failed; canonical Tessera history (if any) is returned for viewing
 */
export interface SessionResumeResult {
  sessionId: string;
  messages: EnhancedMessage[];
  status: 'running' | 'read_only';
  model?: string;
  reasoningEffort?: string | null;
  serviceTier?: string | null;
  sessionMode?: ProviderRuntimeControls['sessionMode'];
  accessMode?: ProviderRuntimeControls['accessMode'];
  usage?: PersistedUsage | null;
  contextUsage?: PersistedContextUsage | null;
  activeInteractivePrompt?: ActiveInteractivePrompt | null;
}

/**
 * Common options shared between session create and resume.
 */
export interface SessionBaseOptions extends ProviderRuntimeControls {
  workDir?: string;
  permissionMode?: string;
  model?: string;
  reasoningEffort?: string | null;
}

/**
 * Options for creating a session
 */
export interface SessionCreateOptions extends SessionBaseOptions {
  providerId: string;
  title?: string;
}

/**
 * Options for resuming a session
 */
export type SessionResumeOptions = SessionBaseOptions;
