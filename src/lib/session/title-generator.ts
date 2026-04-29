/**
 * Session Title Generator
 *
 * Generates human-readable session titles from first user message.
 */

/**
 * Generate a session title from a user message
 *
 * Rules:
 * - If message starts with "!", use command as title
 * - Otherwise, use first line of message (full length — UI handles overflow via CSS)
 * - Sanitize special characters (command path only)
 *
 * @param message - User's first message
 * @returns Generated title, or empty string if message is empty
 *
 * @example
 * generateSessionTitle("!git status") // "git status"
 * generateSessionTitle("Can you help me with React?") // "Can you help me with React?"
 */
export function generateSessionTitle(message: string): string {
  // Remove leading/trailing whitespace
  const cleaned = message.trim();

  // If empty, return empty string (caller will use default "Session N")
  if (!cleaned) {
    return '';
  }

  // If starts with "!", extract command
  if (cleaned.startsWith('!')) {
    const commandMatch = cleaned.match(/^!(\S+)/);
    if (commandMatch) {
      return sanitizeTitle(commandMatch[1]);
    }
  }

  // Use full first line — UI layers (header, tab, kanban card, sidebar, etc.)
  // apply CSS truncation/line-clamp so titles fit whatever width they render in.
  return cleaned.split('\n')[0];
}

/**
 * Sanitize a title by removing special characters
 *
 * Allows:
 * - Alphanumeric (a-z, A-Z, 0-9)
 * - Spaces
 * - Dashes (-)
 * - Underscores (_)
 *
 * @param title - Raw title string
 * @returns Sanitized title
 *
 * @example
 * sanitizeTitle("Hello<script>World") // "HelloscriptWorld"
 * sanitizeTitle("test-file_name") // "test-file_name"
 */
export function sanitizeTitle(title: string): string {
  // Allow Unicode letters/digits (\p{L}, \p{N}), spaces, dashes, underscores
  return title.replace(/[^\p{L}\p{N}\s\-_]/gu, '').trim();
}

/**
 * Generate default session title with incrementing number
 *
 * @param sessionCount - Current number of sessions
 * @returns Default title like "Session 1", "Session 2", etc.
 *
 * @example
 * generateDefaultTitle(0) // "Session 1"
 * generateDefaultTitle(5) // "Session 6"
 */
export function generateDefaultTitle(sessionCount: number): string {
  return `Session ${sessionCount + 1}`;
}
