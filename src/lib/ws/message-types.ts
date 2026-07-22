import type { ToolCallKind } from '@/types/tool-call-kind';
import type { AgentContextEvent } from '@/types/agent-context';
import type { CanonicalToolResultValue } from '@/types/tool-result';
import type { ToolDisplayMetadata } from '@/types/tool-display';
import type { ToolUseResult } from '@/types/cli-jsonl-schemas';
import type { SessionReplayEvent } from '@/lib/session-replay-types';
import type { ProviderRateLimitsSnapshot } from '@/lib/status-display/types';
import type { CliStatusEntry } from '@/lib/cli/connection-checker';
import type { ProviderRuntimeControls } from '@/lib/session/session-control-types';
import type { AgentExecutionMode } from '@/lib/session/agent-execution-mode';
import type {
  TerminalAppearance,
  TerminalLaunchIntent,
  TerminalShellKind,
} from '@/lib/terminal/types';

// ========== ContentBlock 타입 정의 (클립보드 이미지 붙여넣기) ==========

/**
 * 텍스트 콘텐츠 블록
 * CLI stdin 프로토콜: {"type":"text","text":"..."}
 */
export type TextContentBlock = {
  type: 'text';
  text: string;
};

/**
 * 이미지 콘텐츠 블록 (base64 인코딩)
 * CLI stdin 프로토콜: {"type":"image","source":{"type":"base64","media_type":"...","data":"..."}}
 *
 * data 필드: 순수 base64 문자열 (data URL prefix 제외)
 * media_type: Anthropic API 지원 포맷만 허용
 */
export type ImageContentBlock = {
  type: 'image';
  source: {
    type: 'base64';
    media_type: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
    data: string;
  };
};

/**
 * 스킬 콘텐츠 블록
 * CLI stdin 프로토콜: {"type":"skill","name":"...","path":"..."}
 * 스킬(프롬프트/커맨드/스크립트) 참조를 나타내는 블록
 */
export type SkillContentBlock = {
  type: 'skill';
  name: string;
  path: string;
};

/**
 * ContentBlock 유니온 타입
 * 향후 확장 시 (Phase 2): | { type: 'document'; source: { ... } }
 */
export type ContentBlock = TextContentBlock | ImageContentBlock | SkillContentBlock;

// ========== END ContentBlock 타입 정의 ==========

export type SessionSpawnConfig = {
  model?: string;
  reasoningEffort?: string | null;
  permissionMode?: PermissionMode;
} & ProviderRuntimeControls;

// Client → Server messages
export type ClientMessage =
  | ({ type: 'create_session'; requestId: string; workDir?: string; permissionMode?: PermissionMode; providerId: string; model?: string; reasoningEffort?: string | null; executionMode?: AgentExecutionMode } & ProviderRuntimeControls)
  | { type: 'close_session'; requestId: string; sessionId: string }
  | { type: 'send_message'; requestId: string; sessionId: string; content: string | ContentBlock[]; skillName?: string; displayContent?: string | ContentBlock[]; spawnConfig?: SessionSpawnConfig; forceTranslateInput?: boolean; messageId?: string }
  | { type: 'translate_message'; requestId: string; sessionId: string; messageId: string }
  | ({ type: 'resume_session'; requestId: string; sessionId: string; permissionMode?: PermissionMode } & ProviderRuntimeControls)
  | { type: 'retry_session'; requestId: string; sessionId: string }
  | { type: 'interactive_response'; requestId: string; sessionId: string; toolUseId: string; response: string }
  | { type: 'mark_as_read'; requestId: string; sessionId: string } // NEW - for FEAT-002
  | { type: 'cancel_generation'; requestId: string; sessionId: string }
  | { type: 'compact_session'; requestId: string; sessionId: string; spawnConfig?: SessionSpawnConfig; displayContent?: string }
  | ({ type: 'set_permission_mode'; requestId: string; sessionId: string; mode?: PermissionMode } & ProviderRuntimeControls)
  | { type: 'set_model'; requestId: string; sessionId: string; model: string }
  | { type: 'set_reasoning_effort'; requestId: string; sessionId: string; reasoningEffort: string | null }
  | { type: 'set_service_tier'; requestId: string; sessionId: string; serviceTier: string | null; persist?: boolean }
  | { type: 'set_fast_mode'; requestId: string; sessionId: string; fastMode: boolean | null }
  | { type: 'stop_session'; requestId: string; sessionId: string }
  | { type: 'get_commands'; requestId: string; sessionId: string }
  | { type: 'list_providers'; requestId: string }
  | { type: 'refresh_providers'; requestId: string }
  | { type: 'check_cli_status'; requestId: string }
  | {
      type: 'terminal_create';
      requestId: string;
      terminalId: string;
      surfaceId: string;
      previewOwnerToken?: string;
      /** Read-only attach (kanban peek): never claims the viewport or resizes the PTY. */
      viewer?: boolean;
      cwd?: string | null;
      sessionId?: string | null;
      shellKind?: TerminalShellKind;
      cols?: number;
      rows?: number;
      appearance?: TerminalAppearance;
      launchIntent?: TerminalLaunchIntent;
      prefillInput?: string;
      launch?: { providerId: string; sessionId: string };
    }
  | { type: 'terminal_detach'; requestId: string; terminalId: string; surfaceId: string }
  | {
      type: 'terminal_release_preview';
      requestId: string;
      terminalId: string;
      sessionId?: string | null;
      previewOwnerToken: string;
    }
  | { type: 'terminal_input'; requestId: string; terminalId: string; surfaceId: string; data: string }
  | {
      type: 'terminal_set_appearance';
      requestId: string;
      terminalId: string;
      surfaceId: string;
      appearance: TerminalAppearance;
    }
  | {
      type: 'terminal_resize';
      requestId: string;
      terminalId: string;
      surfaceId: string;
      cols: number;
      rows: number;
      claim?: boolean;
    }
  | { type: 'terminal_close'; requestId: string; terminalId: string }
  | { type: 'subscribe_workspace_files'; requestId: string; sessionId: string; subscriberId: string }
  | { type: 'unsubscribe_workspace_files'; requestId: string; sessionId: string; subscriberId: string };

export type PermissionMode = 'default' | 'acceptEdits' | 'plan' | 'dontAsk' | 'bypassPermissions';

export type ReplaySourceServerMessage =
  | { type: 'message'; sessionId: string; role: 'assistant'; content: string; messageId?: string }
  | {
      type: 'user_message';
      sessionId: string;
      content: string | ContentBlock[];
      timestamp: string;
    }
  | {
      type: 'tool_call';
      sessionId: string;
      toolName: string;
      toolKind?: ToolCallKind;
      toolParams: Record<string, any>;
      toolDisplay?: ToolDisplayMetadata;
      status: 'running' | 'completed' | 'error';
      output?: string;
      error?: string;
      toolUseResult?: ToolUseResult | CanonicalToolResultValue;
      agentContext?: AgentContextEvent[];
      toolUseId?: string;
      timestamp: string;
    }
  | {
      type: 'thinking';
      sessionId: string;
      content: string;
      status: 'streaming' | 'completed';
      signature?: string;
      isRedacted?: boolean;
      thinkingId?: string;
      timestamp: string;
    }
  | {
      type: 'thinking_update';
      sessionId: string;
      thinkingId: string;
      contentDelta: string;
      status: 'streaming' | 'completed';
      signature?: string;
      isRedacted?: boolean;
      timestamp: string;
    }
  | {
      type: 'system';
      sessionId: string;
      message: string;
      severity: 'info' | 'warning' | 'error';
      subtype?: string;
      metadata?: Record<string, any>;
      timestamp: string;
    }
  | {
      type: 'progress_hook';
      sessionId: string;
      hookEvent: string;
      data: Record<string, any>;
      progressType?: string;
      timestamp: string;
    }
  | {
      type: 'workflow_event';
      sessionId: string;
      kind: 'started' | 'progress' | 'updated' | 'notification';
      taskId: string;
      toolUseId?: string;
      workflowName?: string;
      description?: string;
      /** Delta batch of phase/agent/log entries (kind === 'progress'). */
      progress?: import('@/types/cli-jsonl-schemas').WorkflowProgressEntry[];
      usage?: { totalTokens?: number; toolUses?: number; durationMs?: number };
      /** Status from task_updated.patch / task_notification. */
      status?: string;
      /** Run end time (epoch ms) from task_updated.patch. */
      endTime?: number;
      /** Final output file (kind === 'notification'). */
      outputFile?: string;
      timestamp: string;
    }
  | {
      type: 'context_usage';
      sessionId: string;
      inputTokens: number;
      cacheCreationTokens: number;
      cacheReadTokens: number;
      contextWindowSize?: number;
    };

export type ReplayEventsTransportMessage = {
  type: 'replay_events';
  sessionId: string;
  events: SessionReplayEvent[];
};

/**
 * Per-model usage breakdown from CLI's modelUsage map.
 * Claude Code reports multiple entries when secondary models (e.g. Haiku for
 * compaction) are used during a turn; Codex always reports a single entry.
 */
export type ModelUsageEntry = {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  webSearchRequests: number;
  costUSD: number;
  contextWindow?: number;
  maxOutputTokens?: number;
};

export type AppServerMessage =
  | ({ type: 'session_created'; sessionId: string; status: 'ready'; workDir: string; permissionMode?: PermissionMode; provider?: string; model?: string; reasoningEffort?: string | null; kind?: 'chat' | 'terminal' } & ProviderRuntimeControls)
  | ({ type: 'session_started'; sessionId: string; workDir: string; permissionMode?: PermissionMode; provider?: string; model?: string; reasoningEffort?: string | null } & ProviderRuntimeControls)
  | { type: 'session_closed'; sessionId: string }
  | {
      type: 'notification';
      sessionId: string;
      event: 'completed' | 'input_required';
      message: string;
      preview: string;
      actions?: Array<{ label: string; value: string | number; primary?: boolean }>;
      usage?: {
        inputTokens: number;
        outputTokens: number;
        cacheReadTokens: number;
        cacheCreationTokens: number;
        cacheCreationEphemeral5m?: number;
        cacheCreationEphemeral1h?: number;
        durationMs: number;
        durationApiMs: number;
        numTurns: number;
        costUsd: number;
        serviceTier?: string;
        inferenceGeo?: string;
        serverToolUse?: {
          webSearchRequests: number;
          webFetchRequests: number;
        };
        speed?: string;
        contextWindowSize?: number;
        maxOutputTokens?: number;
        modelUsage?: ModelUsageEntry[];
      };
    }
  | {
      type: 'session_state';
      sessionId: string;
      terminalId: string;
      status: 'running' | 'completed' | 'input_required' | 'idle';
      hookEvent: string;
      preview?: string;
      /** Active child work prevents an Escape fallback from settling the turn. */
      hasWorkingSubagents?: boolean;
      /**
       * 이 상태 인스턴스의 발생시각(epoch ms). 클라의 알림 dedup 키 재료. 서버가
       * 상태 기록 시 한 번 찍어 저장하고 replay에도 같은 값을 실어, 재연결/리로드로
       * 같은 완료가 다시 도착해도 알림이 중복 발화하지 않게 한다.
       */
      stateAt?: number;
    }
  | {
      type: 'terminal_session_runtime';
      sessionId: string;
      terminalId: string;
      running: boolean;
    }
  | {
      type: 'terminal_session_rebound';
      previousSessionId: string;
      sessionId: string;
      terminalId: string;
    }
  | {
      type: 'terminal_session_runtime_snapshot';
      activeSessionIds: string[];
      reboundSessions?: Array<{
        previousSessionId: string;
        sessionId: string;
        terminalId: string;
      }>;
    }
  | { type: 'error'; sessionId?: string; code: string; message: string; requestId?: string }
  | { type: 'terminal_prefill_written'; terminalId: string }
  | { type: 'terminal_prefill_cancelled'; terminalId: string; message: string }
  | {
      type: 'terminal_appearance';
      terminalId: string;
      surfaceId: string;
      appearance: TerminalAppearance;
      restartRequired: boolean;
      restartAllowed: boolean;
      restartIntent?: TerminalLaunchIntent;
    }
  | {
      type: 'terminal_started';
      terminalId: string;
      surfaceId: string;
      generation: number;
      cwd: string;
      shell: string;
      reattached: boolean;
      appearance?: TerminalAppearance;
    }
  | {
      type: 'terminal_snapshot';
      terminalId: string;
      surfaceId: string;
      generation: number;
      seq: number;
      data: string;
      cols: number;
      rows: number;
      fallback?: boolean;
    }
  | {
      type: 'terminal_output';
      terminalId: string;
      surfaceId: string;
      generation: number;
      seq: number;
      data: string;
    }
  | {
      type: 'terminal_exit';
      terminalId: string;
      surfaceId: string;
      generation: number;
      exitCode: number;
      signal?: number;
    }
  | {
      type: 'terminal_error';
      terminalId: string;
      surfaceId?: string;
      generation?: number;
      message: string;
    }
  | {
      type: 'interactive_prompt';
      sessionId: string;
      promptType: 'select' | 'input' | 'ask_user_question' | 'permission_request' | 'plan_approval';
      data: {
        // Legacy fields (select/input types)
        question: string;
        options?: string[];
        toolUseId: string;
        // AskUserQuestion fields (ask_user_question type)
        questions?: import('@/types/cli-jsonl-schemas').AskUserQuestionItem[];
        metadata?: { source?: string };
        // Permission request fields (permission_request type)
        toolName?: string;
        toolInput?: Record<string, any>;
        decisionReason?: string;
        agentId?: string;
        // Plan approval fields (plan_approval type)
        plan?: string;
        allowedPrompts?: Array<{ tool: string; prompt: string }>;
        planFilePath?: string;
      };
    }
  | { type: 'cli_down'; sessionId: string; exitCode: number; message: string }
  | {
      type: 'session_history';
      sessionId: string;
      messages: import('@/types/chat').EnhancedMessage[];
      usage?: {
        inputTokens: number;
        outputTokens: number;
        cacheReadTokens: number;
        cacheCreationTokens: number;
        cacheCreationEphemeral5m?: number;
        cacheCreationEphemeral1h?: number;
        durationMs: number;
        durationApiMs: number;
        numTurns: number;
        costUsd: number;
        serviceTier?: string;
        inferenceGeo?: string;
        serverToolUse?: {
          webSearchRequests: number;
          webFetchRequests: number;
        };
        speed?: string;
        contextWindowSize?: number;
        maxOutputTokens?: number;
        modelUsage?: ModelUsageEntry[];
      } | null;
      contextUsage?: {
        inputTokens: number;
        cacheCreationTokens: number;
        cacheReadTokens: number;
        contextWindowSize?: number;
      } | null;
      activeInteractivePrompt?: import('@/types/chat').ActiveInteractivePrompt | null;
      todoSnapshot?: import('@/types/cli-jsonl-schemas').TodoItem[];
    }
  | {
      type: 'session_list';
      sessions: Array<{
        id: string;
        status: string;
        isGenerating: boolean;
        createdAt: string;
        activeInteractivePrompt?: import('@/types/chat').ActiveInteractivePrompt | null;
        todoSnapshot?: import('@/types/cli-jsonl-schemas').TodoItem[];
      }>;
      titleGeneratingSessionIds?: string[];
    }
  | {
      type: 'unread_cleared'; // NEW - for FEAT-002
      sessionId: string;
      unreadCount: number;
    }
  | { type: 'session_stopped'; sessionId: string }
  | { type: 'session_idle_closed'; sessionId: string }
  | ({ type: 'rate_limit_update' } & ProviderRateLimitsSnapshot)
  | { type: 'model_config_updated'; providerId: 'claude-code' }
  | {
      type: 'providers_list';
      requestId: string;
      providers: Array<{ id: string; displayName: string; available: boolean }>;
    }
  | {
      type: 'cli_status_result';
      requestId: string;
      results: CliStatusEntry[];
    }
  | {
      type: 'commands_ready' | 'commands_list';
      sessionId: string;
      commands: Array<{ name: string; description: string }>;
      timestamp?: string;
    }
  | {
      type: 'skill_analysis_progress';
      status: 'scanning' | 'analyzing' | 'completed' | 'failed';
      skillCount?: number;
      error?: string;
      result?: import('@/lib/skill/skill-analysis-types').SkillAnalysis;
      startedAt?: string;
      model?: string;
      generatedAt?: string;
      completedCount?: number;
      totalCount?: number;
      currentJobs?: string[];
    }
  | {
      type: 'session_title_updated';
      sessionId: string;
      title: string;
      previousTitle: string;
      /** False for a deterministic placeholder that remains eligible for AI replacement. */
      hasCustomTitle?: boolean;
      /** Suppress rename feedback for automatic local placeholder replacement. */
      silent?: boolean;
    }
  | {
      type: 'session_title_generation';
      sessionId: string;
      isGenerating: boolean;
    }
  | {
      type: 'worktree_diff_stats';
      workDir: string;
      sessionIds: string[];
      taskIds: string[];
      stats: import('@/types/worktree-diff-stats').WorktreeDiffStats | null;
      autoPromotedTaskIds?: string[];
    }
  | {
      type: 'task_pr_status_update';
      taskId: string;
      prStatus?: import('@/types/task-pr-status').TaskPrStatus;
      prUnsupported: boolean;
      remoteBranchExists?: boolean;
    }
  | {
      type: 'session_pr_status_update';
      sessionId: string;
      prStatus?: import('@/types/task-pr-status').TaskPrStatus;
      prUnsupported: boolean;
      remoteBranchExists?: boolean;
    }
  | {
      type: 'git_panel_state';
      sessionId: string;
      data: import('@/types/git').GitPanelData;
    }
  | {
      type: 'workspace_files_changed';
      workDir: string;
      sessionIds: string[];
      version: number;
      treeChanged: boolean;
      changedPaths: string[];
      addedPaths: string[];
      deletedPaths: string[];
      hasMoreChangedPaths: boolean;
    }
  | {
      type: 'workspace_file_watch_status';
      sessionId: string;
      subscriberId: string;
      status: 'starting' | 'active' | 'fallback';
      version?: number;
      workDir?: string;
      reason?: string;
    }
  | {
      type: 'session_mutated';
      kind: 'created' | 'updated' | 'deleted' | 'reordered' | 'project_reordered' | 'project_deleted';
      originClientId?: string;
      projectId?: string;
    }
  | {
      type: 'task_mutated';
      kind: 'created' | 'updated' | 'deleted' | 'reordered';
      originClientId?: string;
      projectId: string;
    }
  | {
      type: 'collection_mutated';
      kind: 'created' | 'updated' | 'deleted';
      originClientId?: string;
      projectId: string;
    };

/**
 * Backward-compatible union used by legacy parser helpers.
 * Prefer `ReplaySourceServerMessage` or `AppServerMessage` in new code.
 */
export type ServerMessage = ReplaySourceServerMessage | AppServerMessage;

export type ReplayTransportedServerMessage = ReplaySourceServerMessage;

export type ServerTransportMessage = ReplayEventsTransportMessage | AppServerMessage;
