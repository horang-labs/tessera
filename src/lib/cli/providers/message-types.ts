import type { ServerMessage } from '@/lib/ws/message-types';
import type { ToolCallKind } from '@/types/tool-call-kind';
import type { ToolDisplayMetadata } from '@/types/tool-display';
import type { CliCommandInfo } from '../process-types';

/**
 * A parsed stdout line from the CLI process.
 *
 * serverMessage: the WebSocket message to forward to the client. Null if this
 * stdout line should produce no WS message (e.g. a progress heartbeat that
 * the provider chooses to suppress).
 *
 * sideEffect: an optional signal for state mutations that the parser cannot
 * perform directly (e.g. updating processManager.isGenerating). The caller
 * (protocol-adapter or equivalent) inspects this and calls the appropriate
 * manager methods, keeping the parser pure / side-effect-free.
 */
export interface ParsedMessage {
  /** The WebSocket message to send to the client, or null to suppress. */
  serverMessage: ServerMessage | null;
  /** Optional side-effect descriptor for the process manager. */
  sideEffect?: ParsedMessageSideEffect;
}

/**
 * Descriptor for a side effect that the message parser cannot perform itself.
 * The caller reads this and calls the appropriate method on processManager.
 */
export type ParsedMessageSideEffect =
  | { type: 'set_generating'; value: boolean }
  | { type: 'update_last_assistant_message'; content: string }
  | {
      type: 'add_pending_tool_call';
      toolUseId: string;
      toolName: string;
      toolKind?: ToolCallKind;
      toolParams: Record<string, any>;
      toolDisplay?: ToolDisplayMetadata;
    }
  | { type: 'remove_pending_tool_call'; toolUseId: string }
  | {
      type: 'add_pending_permission_request';
      toolUseId: string;
      requestId: string;
      toolName: string;
      input: Record<string, any>;
    }
  | { type: 'remove_pending_permission_request'; toolUseId: string }
  | { type: 'update_provider_state'; providerState: Record<string, unknown> }
  | { type: 'store_commands'; commands: CliCommandInfo[] }
  | { type: 'auto_generate_title' };
