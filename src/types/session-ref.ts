/**
 * Session Reference types for drag-and-drop session context injection.
 *
 * Users can drag session cards from sidebar/kanban onto the chat input
 * to reference past conversation content. At send time, the referenced
 * session is exported as markdown and the file path is injected inline.
 */

/** A single session reference dropped into the message input */
export interface SessionRefItem {
  /** Monotonically increasing client-side slot number, matches [📎 N] placeholder */
  slot: number;
  /** The referenced session's UUID */
  sessionId: string;
  /** Display title for the chip */
  title: string;
  /** Whether the referenced session is a standalone chat or a kanban task */
  kind: 'chat' | 'task';
  /** Export lifecycle for optimistic drag-and-drop insertion */
  status: 'pending' | 'ready' | 'error';
  /** Absolute path to the exported markdown file (resolved asynchronously after drop) */
  exportPath?: string;
}

/** Regex to match [📎 N] placeholders in textarea text */
export const SESSION_REF_PLACEHOLDER_REGEX = /\[📎\s*(\d+)\]/g;

/** Maximum number of session references per message */
export const MAX_SESSION_REFS = 5;
