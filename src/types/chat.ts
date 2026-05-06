import type { ToolUseResult, AskUserQuestionItem } from './cli-jsonl-schemas';
import type { CanonicalToolResultValue } from './tool-result';
import type { ToolCallKind } from './tool-call-kind';
import type { ToolDisplayMetadata } from './tool-display';
import type { ContentBlock } from '@/lib/ws/message-types';
import type { WorkflowStatus } from './task-entity';

// New message types for protocol adapter → frontend
// Base message fields
interface BaseEnhancedMessage {
  id: string;
  timestamp: string;
}

// Text message (existing behavior)
export interface TextMessage extends BaseEnhancedMessage {
  type: 'text';
  role: 'user' | 'assistant' | 'system';
  /**
   * 텍스트 전용 메시지: string
   * 이미지 포함 user 메시지: ContentBlock[]
   * assistant/system role 메시지는 항상 string.
   */
  content: string | ContentBlock[];
}

// Tool call message (NEW)
export interface ToolCallMessage extends BaseEnhancedMessage {
  type: 'tool_call';
  sessionId: string;
  toolUseId?: string;
  toolName: string;
  toolKind?: ToolCallKind;
  toolParams: Record<string, any>;
  toolDisplay?: ToolDisplayMetadata;
  status: 'running' | 'completed' | 'error';
  output?: string;
  error?: string;
  toolUseResult?: ToolUseResult | CanonicalToolResultValue;
  /** True when output/toolUseResult were stripped for lazy loading (read-only sessions) */
  hasOutput?: boolean;
}

// Thinking message (NEW)
export interface ThinkingMessage extends BaseEnhancedMessage {
  type: 'thinking';
  sessionId: string;
  content: string;
  status: 'streaming' | 'completed';
  signature?: string;
  isRedacted?: boolean;
  /** Stable ID for matching thinking_update messages to this block */
  thinkingId?: string;
  /** Thinking 토큰 수 (CLI usage 필드에서 추출) */
  tokenCount?: number;
  /** Thinking 시작 시각 (ISO 8601 타임스탬프) */
  startTime?: string;
  /** Thinking 완료 시각 (ISO 8601 타임스탬프) */
  endTime?: string;
  /** 경과 시간 (밀리초) */
  elapsedMs?: number;
}

// System message (NEW)
export interface SystemMessage extends BaseEnhancedMessage {
  type: 'system';
  sessionId: string;
  message: string;
  severity: 'info' | 'warning' | 'error';
  subtype?: string;
  metadata?: Record<string, any>;
}

// Progress hook message (NEW)
export interface ProgressHookMessage extends BaseEnhancedMessage {
  type: 'progress_hook';
  sessionId: string;
  hookEvent: string;
  data: Record<string, any>;
  progressType?: string;
  /** 도구 input 파라미터 (MCP Progress용) */
  toolInput?: Record<string, any>;
  /** 실패 시 에러 메시지 */
  errorMessage?: string;
}

// Enhanced message type (for Unit 4 - Message Rendering)
export type EnhancedMessage = TextMessage | ToolCallMessage | ThinkingMessage | SystemMessage | ProgressHookMessage;

// Active interactive prompt (floating bar/panel state, separate from message stream)
export interface ActiveInteractivePrompt {
  promptType: 'permission_request' | 'ask_user_question' | 'plan_approval' | 'select' | 'input';
  toolUseId: string;
  sessionId: string;
  // Permission fields
  toolName?: string;
  toolInput?: Record<string, any>;
  decisionReason?: string;
  agentId?: string;
  // AskUserQuestion fields
  questions?: AskUserQuestionItem[];
  metadata?: { source?: string };
  // Plan approval fields
  plan?: string;
  allowedPrompts?: Array<{ tool: string; prompt: string }>;
  planFilePath?: string;
  // Legacy fields
  question?: string;
  options?: string[];
}

export type SessionStatus = 'starting' | 'running' | 'completed' | 'error' | 'stopped';

export type ConnectionStatus = 'connected' | 'reconnecting' | 'disconnected' | 'error';

// ========== UNIT-05: Sidebar Redesign Types ==========

/** Unified session representation -- replaces both Session and PastSession */
export interface UnifiedSession {
  /** CLI session ID (UUID from JSONL filename) */
  id: string;
  /** Session title -- custom-title if set, otherwise first user prompt */
  title: string;
  /** Encoded project directory name */
  projectDir: string;
  /** Whether a CLI process is currently running for this session */
  isRunning: boolean;
  /** Session status (only meaningful when isRunning=true) */
  status: SessionStatus;
  /** Last modified timestamp (JSONL file mtime) */
  lastModified: string;
  /** Created timestamp */
  createdAt: string;
  /** Tessera internal session ID (for active sessions managed by ProcessManager) */
  tesseraSessionId?: string;
  /** Whether messages are loaded in read-only mode (no CLI process) */
  isReadOnly?: boolean;
  /** Unread notification count (incremented on notification, cleared on view) */
  unreadCount?: number;
  /** Whether the title was explicitly set by user (prevents auto-title overwrite) */
  hasCustomTitle?: boolean;

  /**
   * Workflow state derived from the parent task.
   * Undefined for plain chat sessions that are not linked to a task.
   */
  workflowStatus?: WorkflowStatus;

  /**
   * Git worktree branch connected to this task.
   * Undefined when no worktree is linked.
   */
  worktreeBranch?: string;
  /** Working directory used by this session or managed worktree. */
  workDir?: string;

  /**
   * Whether this task has been archived by the user.
   * Archived tasks are hidden from status groups and kanban columns.
   * Default false applied at load time.
   */
  archived: boolean;
  /** Timestamp when the item was archived. */
  archivedAt?: string;
  /** Timestamp when retention removed the physical worktree. */
  worktreeDeletedAt?: string;

  /**
   * CLI provider ID used for this session (e.g. 'claude-code', 'codex').
   * Undefined for legacy sessions created before multi-provider support.
   */
  provider?: string;

  /**
   * Runtime model controls currently attached to this session.
   * Before the CLI starts, empty values fall back to provider defaults.
   */
  model?: string;
  reasoningEffort?: string | null;

  /**
   * Task entity ID this session belongs to.
   * Undefined when the session is not linked to any task.
   */
  taskId?: string;

  /**
   * Collection ID this session belongs to.
   * Undefined when the session is uncategorized.
   */
  collectionId?: string;

  /** Project-local display order. Lower values appear first. */
  sortOrder: number;

  /** Worktree diff stats (+/−). Populated asynchronously; undefined until known. */
  diffStats?: import('./worktree-diff-stats').WorktreeDiffStats | null;
}

/** Represents a project directory containing sessions */
export interface ProjectGroup {
  /** Encoded directory name (e.g., "-path-to-tessera") */
  encodedDir: string;
  /** Display name -- folder name only (e.g., "tessera") */
  displayName: string;
  /** Decoded filesystem path (e.g., "/path/to/tessera") */
  decodedPath: string;
  /** Human-readable path formatted for the active agent environment. */
  displayPath?: string;
  /** Whether this is the current project (matches process.cwd()) */
  isCurrent: boolean;
  /** Sessions in this project, sorted by lastModified desc */
  sessions: UnifiedSession[];
  /** Total session count (may exceed sessions.length if truncated) */
  totalSessions: number;
  /** Whether all sessions have been loaded */
  allLoaded: boolean;
  /** Number of sessions loaded from API so far (for offset calculation) */
  loadedCount: number;
  /** Cursor for next page of sessions (mtime ISO of oldest loaded session) */
  nextCursor: string | null;
  /** Index tracking how many times "Load More" has been clicked (for progressive batch sizing) */
  loadBatchIndex: number;
  /** Total session count per sidebar bucket (chat + workflow statuses) */
  countByStatus?: Record<string, number>;
  /** Cursor per sidebar bucket for "load more" within a status group */
  cursorByStatus?: Record<string, string | null>;
}
