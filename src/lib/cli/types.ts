/**
 * Backwards-compatible barrel for shared CLI runtime types.
 *
 * Split by responsibility:
 * - process-types.ts: live process/session runtime state
 * - session-types.ts: persisted session metadata
 * - protocol-message-types.ts: wire-format message payloads
 */

export type {
  CliCommandInfo,
  PendingPermissionRequest,
  PendingToolCall,
  ProcessInfo,
} from './process-types';
export type { CliMessage } from './protocol-message-types';
export type { SessionInfo } from './session-types';
