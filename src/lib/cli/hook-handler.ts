import logger from '../logger';

export class HookHandler {
  /**
   * Handle Stop hook (task completed)
   */
  handleStopHook(sessionId: string, userId: string, lastMessage?: string): void {
    const preview = this.extractPreview(lastMessage || '');

    logger.info({
      sessionId,
      userId,
      preview,
      }, 'Stop hook processed');
  }

  /**
   * Handle Notification hook (input required)
   */
  handleNotificationHook(sessionId: string, userId: string, message: string): void {
    const preview = this.extractPreview(message);

    logger.info({
      sessionId,
      userId,
      preview,
      }, 'Notification hook processed');
  }

  /**
   * Handle SessionStart hook
   */
  handleSessionStartHook(sessionId: string, userId: string): void {
    logger.info({ sessionId, userId }, 'SessionStart hook processed');
  }

  /**
   * Extract preview text from assistant message (first 50 chars)
   */
  private extractPreview(content: string): string {
    if (!content) return '';

    // Remove markdown code blocks
    const cleaned = content
      .replace(/```[\s\S]*?```/g, '[code]')
      .replace(/`[^`]+`/g, '[code]')
      .trim();

    if (cleaned.length === 0) return 'No preview available';

    return cleaned.substring(0, 50) + (cleaned.length > 50 ? '...' : '');
  }
}

// Singleton instance
export const hookHandler = new HookHandler();
