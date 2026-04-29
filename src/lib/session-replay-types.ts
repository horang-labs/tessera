import type { ContentBlock, ModelUsageEntry } from './ws/message-types';
import type { ToolCallKind } from '@/types/tool-call-kind';
import type { CanonicalToolResultValue } from '@/types/tool-result';
import type { ToolDisplayMetadata } from '@/types/tool-display';
import type { ToolUseResult } from '@/types/cli-jsonl-schemas';

export interface PersistedUsage {
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
}

export interface PersistedContextUsage {
  inputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  contextWindowSize?: number;
}

export type SessionHistoryEvent =
  | {
      v: number;
      type: 'user_message';
      timestamp: string;
      content: string | ContentBlock[];
    }
  | {
      v: number;
      type: 'assistant_message';
      timestamp: string;
      content: string;
    }
  | {
      v: number;
      type: 'tool_call';
      timestamp: string;
      toolName: string;
      toolKind?: ToolCallKind;
      toolParams: Record<string, any>;
      toolDisplay?: ToolDisplayMetadata;
      status: 'running' | 'completed' | 'error';
      output?: string;
      error?: string;
      toolUseResult?: ToolUseResult | CanonicalToolResultValue;
      toolUseId?: string;
    }
  | {
      v: number;
      type: 'thinking';
      timestamp: string;
      content: string;
      signature?: string;
      isRedacted?: boolean;
      thinkingId?: string;
      startTime?: string;
      endTime?: string;
      elapsedMs?: number;
    }
  | {
      v: number;
      type: 'system';
      timestamp: string;
      message: string;
      severity: 'info' | 'warning' | 'error';
      subtype?: string;
      metadata?: Record<string, any>;
    }
  | {
      v: number;
      type: 'progress_hook';
      timestamp: string;
      hookEvent: string;
      data: Record<string, any>;
      progressType?: string;
    }
  | {
      v: number;
      type: 'interactive_prompt';
      timestamp: string;
      promptType: 'select' | 'input' | 'ask_user_question' | 'permission_request' | 'plan_approval';
      data: Record<string, any>;
    }
  | {
      v: number;
      type: 'interactive_prompt_response';
      timestamp: string;
      toolUseId: string;
      response: string;
    }
  | {
      v: number;
      type: 'context_usage';
      timestamp: string;
      inputTokens: number;
      cacheCreationTokens: number;
      cacheReadTokens: number;
      contextWindowSize?: number;
    }
  | {
      v: number;
      type: 'usage';
      timestamp: string;
      usage: PersistedUsage;
    };

export type SessionReplayEvent =
  | SessionHistoryEvent
  | {
      v: number;
      type: 'assistant_message_chunk';
      timestamp: string;
      content: string;
    }
  | {
      v: number;
      type: 'thinking_start';
      timestamp: string;
      content?: string;
      signature?: string;
      isRedacted?: boolean;
      thinkingId?: string;
    }
  | {
      v: number;
      type: 'thinking_delta';
      timestamp: string;
      contentDelta: string;
      signature?: string;
      isRedacted?: boolean;
      thinkingId?: string;
      status: 'streaming' | 'completed';
    }
  | {
      v: number;
      type: 'interactive_prompt_cleared';
      timestamp: string;
      toolUseId?: string;
    };
