import type { ChildProcess } from 'child_process';
import type { CliProvider, SkillSource } from './providers/types';
import type { ToolCallKind } from '@/types/tool-call-kind';
import type { ToolDisplayMetadata } from '@/types/tool-display';

export interface CliCommandInfo {
  name: string;
  description: string;
}

export interface PendingToolCall {
  toolName: string;
  toolKind?: ToolCallKind;
  toolParams: Record<string, any>;
  toolDisplay?: ToolDisplayMetadata;
}

export interface PendingPermissionRequest {
  requestId: string;
  toolName: string;
  input: Record<string, any>;
}

export interface ProcessInfo {
  sessionId: string;
  userId: string;
  process: ChildProcess;
  provider: CliProvider;
  status: 'starting' | 'running' | 'error' | 'stopped';
  createdAt: Date;
  /** Last activity timestamp (stdin write or stdout receive). Used by idle reaper. */
  lastActivityAt: Date;
  /** True while the CLI is actively generating a response (between user message and result) */
  isGenerating: boolean;
  lastAssistantMessage?: string;
  pendingToolCalls?: Map<string, PendingToolCall>;
  /**
   * Pending SDK control_request permission requests (keyed by toolUseId).
   * When the CLI needs permission or user input (e.g. AskUserQuestion),
   * it sends a control_request on stdout and waits for a control_response on stdin.
   */
  pendingPermissionRequests?: Map<string, PendingPermissionRequest>;
  /** Commands/skills reported by CLI via initialize control_response */
  commands?: CliCommandInfo[];
  /** Provider-backed skill discovery for slash-command style skills. */
  skillSource?: SkillSource;
  /** Runtime model controls currently attached to this live process. */
  model?: string;
  reasoningEffort?: string | null;
  serviceTier?: string | null;
}
