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
        autoTitleTriggered.delete(sessionId);
        return;
      }

      const settings = await SettingsManager.load(userId);
      if (!settings.notifications?.aiTitleRefinement) {
        autoTitleTriggered.delete(sessionId);
        return;
      }

      const result = await generateAITitle(sessionId, userId, {
        fallbackToFirstUserMessage: true,
      });
      const latestSession = dbSessions.getSession(sessionId);
      if (!latestSession || latestSession.has_custom_title) {
        autoTitleTriggered.delete(sessionId);
        return;
      }
      const previousTitle = latestSession.title;

      dbSessions.updateSession(
        sessionId,
        {
          title: result.title,
          // A deterministic fallback is visible immediately but remains eligible
          // for AI replacement on the next provider Stop event.
          has_custom_title: result.fallback ? 0 : 1,
        },
        { skipTimestamp: true },
      );
      syncSingleSessionTaskTitleFromSession(sessionId, result.title);

      sendAppMessage(userId, {
        type: 'session_title_updated',
        sessionId,
        title: result.title,
        previousTitle,
        hasCustomTitle: result.fallback !== true,
      });

      if (result.fallback) {
        autoTitleTriggered.delete(sessionId);
      }

      logger.info({
        sessionId,
        title: result.title,
        fallback: result.fallback === true,
      }, 'Auto-generated AI title');
    } catch (error: any) {
      autoTitleTriggered.delete(sessionId);
      logger.warn({ sessionId, error: error.message }, 'Auto-title generation failed');
    }
  })();
}
