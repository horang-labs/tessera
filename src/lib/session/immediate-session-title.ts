import * as dbSessions from '@/lib/db/sessions';
import logger from '@/lib/logger';
import { syncSingleSessionTaskTitleFromSession } from '@/lib/task-title-sync';
import { generateSessionTitle } from './title-generator';

const PLACEHOLDER_TITLES = new Set([
  'New Task',
  'New Worktree',
  '새 태스크',
  '새 워크트리',
  '新しいタスク',
  '新しいワークツリー',
  '新建任务',
  '新建工作树',
]);

export interface ImmediateSessionTitleUpdate {
  previousTitle: string;
  title: string;
}

function isPlaceholderTitle(title: string): boolean {
  const normalized = title.trim();
  return /^Session \d+$/u.test(normalized) || PLACEHOLDER_TITLES.has(normalized);
}

/**
 * Replace an untouched placeholder using the synchronous local title generator.
 * Manual and already-generated titles always take precedence.
 */
export function applyImmediateSessionTitle(
  sessionId: string,
  prompt: string,
): ImmediateSessionTitleUpdate | null {
  try {
    const session = dbSessions.getSession(sessionId);
    if (
      !session
      || session.has_custom_title
      || !isPlaceholderTitle(session.title)
    ) {
      return null;
    }

    const title = generateSessionTitle(prompt);
    if (!title) {
      return null;
    }

    const previousTitle = session.title;
    dbSessions.updateSession(sessionId, { title }, { skipTimestamp: true });
    syncSingleSessionTaskTitleFromSession(sessionId, title);
    return { previousTitle, title };
  } catch (error) {
    logger.warn({ sessionId, error }, 'Failed to apply immediate session title');
    return null;
  }
}
