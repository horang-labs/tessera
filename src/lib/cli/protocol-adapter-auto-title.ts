import * as dbSessions from '../db/sessions';
import logger from '../logger';
import { generateAITitle } from '../session/ai-title-generator';
import { SettingsManager } from '../settings/manager';
import { syncSingleSessionTaskTitleFromSession } from '../task-title-sync';
import type { AppServerMessage } from '../ws/message-types';

interface MaybeAutoGenerateProtocolTitleArgs {
  autoTitleTriggered: Set<string>;
  sendAppMessage: (userId: string, message: AppServerMessage) => void;
  sessionId: string;
  userId: string;
}

export function maybeAutoGenerateProtocolTitle({
  autoTitleTriggered,
  sendAppMessage,
  sessionId,
  userId,
}: MaybeAutoGenerateProtocolTitleArgs): void {
  if (autoTitleTriggered.has(sessionId)) {
    return;
  }
  autoTitleTriggered.add(sessionId);

  void (async () => {
    try {
      const dbSession = dbSessions.getSession(sessionId);
      if (!dbSession || dbSession.has_custom_title) {
        return;
      }

      const settings = await SettingsManager.load(userId);
      if (settings.notifications?.autoGenerateTitle === false) {
        return;
      }

      const previousTitle = dbSession.title;
      const result = await generateAITitle(sessionId, userId);

      dbSessions.updateSession(
        sessionId,
        {
          title: result.title,
          has_custom_title: 1,
        },
        { skipTimestamp: true },
      );
      syncSingleSessionTaskTitleFromSession(sessionId, result.title);

      sendAppMessage(userId, {
        type: 'session_title_updated',
        sessionId,
        title: result.title,
        previousTitle,
      });

      logger.info({ sessionId, title: result.title }, 'Auto-generated AI title');
    } catch (error: any) {
      logger.warn({ sessionId, error: error.message }, 'Auto-title generation failed');
    }
  })();
}
